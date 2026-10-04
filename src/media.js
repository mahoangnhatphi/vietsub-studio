import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toAss } from './subtitles.js';

export const MAX_BYTES = 250 * 1024 * 1024;
export const MAX_DURATION = 20 * 60;
const asset = (file) => new URL(`${import.meta.env.BASE_URL}${file}`, document.baseURI).href;

export async function fetchVideo(link, signal, progress) {
  const url = new URL(link);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Chỉ hỗ trợ URL HTTP/HTTPS.');
  if (/(^|\.)(facebook\.com|fb\.watch|tiktok\.com|youtube\.com|youtu\.be)$/i.test(url.hostname)) {
    throw new Error('Đây là trang mạng xã hội, không phải tệp video. Hãy tải video về máy rồi chọn tệp; bản client-only không chạy yt-dlp/proxy.');
  }
  let response;
  try { response = await fetch(url, { signal, credentials: 'omit' }); }
  catch (error) {
    if (signal.aborted) throw error;
    throw new Error('Không tải được URL. Máy chủ video phải cho phép CORS; hãy chọn tệp trên máy.');
  }
  if (!response.ok) throw new Error(`Tải video lỗi HTTP ${response.status}.`);
  if (response.headers.get('content-type')?.includes('text/html')) throw new Error('URL trả về trang HTML, cần link trực tiếp đến tệp video.');
  const total = Number(response.headers.get('content-length'));
  if (total > MAX_BYTES) { await response.body.cancel(); throw new Error('Video vượt quá 250 MB.'); }
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Video vượt quá 250 MB.');
      parts.push(value);
      progress(`Đang tải video: ${(size / 1048576).toFixed(1)} MB`);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return new File(parts, decodeURIComponent(url.pathname.split('/').pop() || 'video.mp4'), { type: response.headers.get('content-type') || 'video/mp4' });
}

export async function metadata(url, signal) {
  const video = document.createElement('video');
  video.preload = 'metadata';
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Không đọc được video trong 30 giây.')), 30000);
      const abort = () => finish(new DOMException('Đã hủy', 'AbortError'));
      function finish(error) {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
      }
      video.onloadedmetadata = () => finish();
      video.onerror = () => finish(new Error('Trình duyệt không đọc được codec video. Hãy dùng MP4 (H.264/AAC) hoặc WebM.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      video.src = url;
    });
  } finally { video.removeAttribute('src'); video.load(); }
}

export class MediaEngine {
  constructor() { this.ffmpeg = new FFmpeg(); this.logs = []; }
  async load() {
    this.ffmpeg.on('log', ({ message }) => { this.logs.push(message); if (this.logs.length > 12) this.logs.shift(); });
    await this.ffmpeg.load({ coreURL: asset('runtime/ffmpeg/ffmpeg-core.js'), wasmURL: asset('runtime/ffmpeg/ffmpeg-core.wasm') });
  }
  async exec(args) {
    const status = await this.ffmpeg.exec(args);
    if (status !== 0) throw new Error(`FFmpeg không xử lý được video (${status}). ${this.logs.slice(-3).join(' ')}`);
  }
  async input(file) { await this.ffmpeg.writeFile('input.video', new Uint8Array(await file.arrayBuffer())); }
  async extract(file) {
    await this.load();
    await this.input(file);
    await this.exec(['-i', 'input.video', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'audio.raw']);
    const bytes = await this.ffmpeg.readFile('audio.raw');
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  async burn(file, segments, duration, progress) {
    await this.load();
    await this.input(file);
    const font = await fetch(asset('fonts/NotoSans-Regular.ttf'));
    if (!font.ok) throw new Error('Không tải được font tiếng Việt.');
    await this.ffmpeg.createDir('fonts');
    await this.ffmpeg.writeFile('fonts/NotoSans-Regular.ttf', new Uint8Array(await font.arrayBuffer()));
    await this.ffmpeg.writeFile('subtitles.ass', new TextEncoder().encode(toAss(segments)));
    this.ffmpeg.on('progress', ({ time }) => progress(Math.min(99, Math.max(0, time / 1e6 / duration * 100))));
    await this.exec(['-i', 'input.video', '-vf', 'ass=subtitles.ass:fontsdir=fonts', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'output.mp4']);
    const bytes = await this.ffmpeg.readFile('output.mp4');
    return new Blob([bytes], { type: 'video/mp4' });
  }
  dispose() { this.ffmpeg.terminate(); }
}
