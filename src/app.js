import { MediaEngine, MAX_BYTES, MAX_DURATION, fetchVideo, metadata } from './media.js';
import { Inference } from './inference.js';
import { translateOpenRouter } from './openrouter.js';
import { normalizeSegments, normalizeVietnamese, parseSrt, toSrt, toVtt, SubtitleTrack } from './subtitles.js';

const $ = (selector) => document.querySelector(selector);
const player = $('#player');
const subtitleTrack = new SubtitleTrack(player);
const urls = new Set();
let mode = 'upload';
let result = null;
let active = null;
let sourceRevision = 0;
const makeURL = (blob) => { const url = URL.createObjectURL(blob); urls.add(url); return url; };
const revoke = (url) => { if (url) { URL.revokeObjectURL(url); urls.delete(url); } };

function progress(message, value = 0, title = 'Đang xử lý trên trình duyệt') {
  $('#progress-card').classList.remove('hidden');
  $('#state-title').textContent = title;
  $('#status-message').textContent = message;
  $('#percent').textContent = Math.round(value);
  $('#meter-fill').style.width = `${value}%`;
}

function setMode(next) {
  mode = next;
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.mode === mode);
    tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
  }
  $('#mode-upload').classList.toggle('hidden', mode !== 'upload');
  $('#mode-link').classList.toggle('hidden', mode !== 'link');
  $('#video').required = mode === 'upload';
  $('#video-link').required = mode === 'link';
}
for (const tab of document.querySelectorAll('.tab')) tab.onclick = () => setMode(tab.dataset.mode);
$('#toggle-key').onclick = () => {
  const hidden = $('#api-key').type === 'password';
  $('#api-key').type = hidden ? 'text' : 'password';
  $('#toggle-key').textContent = hidden ? 'Ẩn' : 'Hiện';
};
function fileLabel() {
  const file = $('#video').files[0];
  $('#file-label').textContent = file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : 'Chọn video hoặc thả tệp vào đây';
}
$('#video').onchange = fileLabel;
$('.drop-zone').ondragover = (event) => event.preventDefault();
$('.drop-zone').ondrop = (event) => {
  event.preventDefault();
  if (active || !event.dataTransfer.files.length) return;
  $('#video').files = event.dataTransfer.files;
  fileLabel();
};

function begin() {
  const job = { controller: new AbortController(), media: null, ai: null };
  job.check = () => job.controller.signal.throwIfAborted();
  active = job;
  $('#inputs').disabled = true;
  $('#burn').disabled = true;
  $('#cancel').classList.remove('hidden');
  return job;
}
function finish(job) {
  job.media?.dispose();
  job.ai?.dispose();
  if (active === job) {
    active = null;
    $('#inputs').disabled = false;
    $('#burn').disabled = false;
    $('#cancel').classList.add('hidden');
  }
}
$('#cancel').onclick = () => {
  if (!active) return;
  active.controller.abort();
  active.media?.dispose();
  active.ai?.dispose();
};

function resetResult() {
  sourceRevision++;
  result = null;
  player.pause();
  subtitleTrack.clear();
  player.removeAttribute('src');
  delete player.dataset.source;
  player.load();
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  $('#result-card').classList.add('hidden');
  $('#video-download').classList.add('hidden');
  $('#toggle-burn').checked = false;
}
function applySubtitles() {
  subtitleTrack.show(Boolean(result && $('#toggle-subs').checked && !$('#toggle-burn').checked));
}
function renderPlayer(preserveTime = true) {
  if (!result) return;
  const burned = $('#toggle-burn').checked && result.burnURL;
  const url = burned || result.videoURL;
  $('#toggle-subs').disabled = Boolean(burned);
  $('#toggle-burn').disabled = !result.burnURL;
  if (player.dataset.source !== url) {
    const time = preserveTime ? player.currentTime || 0 : 0;
    const playing = preserveTime && !player.paused;
    const revision = ++sourceRevision;
    player.dataset.source = url;
    player.src = url;
    player.addEventListener('loadedmetadata', () => {
      if (revision !== sourceRevision) return;
      player.currentTime = Math.min(time, player.duration || 0);
      applySubtitles();
      if (playing) player.play().catch(() => {});
    }, { once: true });
  }
  applySubtitles();
}
$('#toggle-subs').onchange = applySubtitles;
$('#toggle-burn').onchange = () => renderPlayer();
$('#replay').onclick = () => { player.currentTime = 0; player.play().catch(() => {}); };

function showResult() {
  // Always replace cues, even when the video URL itself hasn't changed.
  subtitleTrack.replace(result.segments);
  $('#srt-download').href = makeURL(new Blob([toSrt(result.segments)], { type: 'application/x-subrip;charset=utf-8' }));
  $('#vtt-download').href = makeURL(new Blob([toVtt(result.segments)], { type: 'text/vtt;charset=utf-8' }));
  $('#result-card').classList.remove('hidden');
  $('#result-note').textContent = `${result.segments.length} câu · ${result.engine}. Xem thử, tải SRT/VTT hoặc xuất MP4.`;
  renderPlayer(false);
}

$('#job-form').onsubmit = async (event) => {
  event.preventDefault();
  if (active) return;
  resetResult();
  const job = begin();
  const signal = job.controller.signal;
  const language = $('#language').value;
  let videoURL;
  try {
    progress('Đang đọc video…', 2);
    const file = mode === 'upload' ? $('#video').files[0] : await fetchVideo($('#video-link').value.trim(), signal, (message) => progress(message, 3));
    job.check();
    if (!file || !file.size) throw new Error('Hãy chọn video có dữ liệu.');
    if (file.size > MAX_BYTES) throw new Error('Video vượt quá 250 MB. Hãy chia thành các đoạn ngắn.');
    videoURL = makeURL(file);
    const info = await metadata(videoURL, signal);
    job.check();
    if (!Number.isFinite(info.duration) || info.duration <= 0 || info.duration > MAX_DURATION) throw new Error('Video cần có thời lượng từ 0 đến 20 phút.');
    let segments;
    const srt = $('#source-srt').files[0];
    if (srt) {
      if (srt.size > 5 * 1024 * 1024) throw new Error('SRT vượt quá 5 MB.');
      segments = normalizeSegments(parseSrt(await srt.text()), info.duration);
    } else {
      progress('Đang tải FFmpeg và trích âm thanh…', 8);
      job.media = new MediaEngine();
      const audio = await job.media.extract(file);
      job.media.dispose();
      job.media = null;
      job.check();
      job.ai = new Inference();
      const chunks = await job.ai.run('transcribe', { audio, language, model: $('#whisper-model').value }, (message) => progress(message, 30), [audio.buffer]);
      job.check();
      segments = normalizeSegments(chunks, info.duration);
    }
    job.check();
    let engine = 'Giữ nguyên tiếng Việt';
    if (language !== 'vi') {
      const translationProgress = (message, fraction = 0) => progress(message, 55 + fraction * 43);
      const key = $('#api-key').value.trim();
      let translated;
      let fallback = false;
      if (key) {
        try {
          translationProgress('Đang dịch bằng OpenRouter…');
          translated = await translateOpenRouter(segments, key, signal, translationProgress);
          engine = 'OpenRouter';
        } catch (error) {
          job.check();
          fallback = true;
          translationProgress(`${error.message}. Chuyển sang model dịch trên máy…`);
        }
      }
      if (!translated) {
        job.ai ||= new Inference();
        translated = await job.ai.run('translate', { segments, language }, translationProgress);
        engine = fallback ? 'Model cục bộ (OpenRouter lỗi)' : 'Model cục bộ';
      }
      job.check();
      segments = normalizeSegments(translated.map((s) => ({ ...s, text: normalizeVietnamese(s.text) })), info.duration);
    }
    result = { file, videoURL, segments, duration: info.duration, engine, burnURL: null };
    showResult();
    progress('Phụ đề đã sẵn sàng.', 100, 'Hoàn tất');
  } catch (error) {
    revoke(videoURL);
    progress(signal.aborted ? 'Đã hủy xử lý.' : (error.message || String(error)), 0, signal.aborted ? 'Đã hủy' : 'Không xử lý được');
  } finally { finish(job); }
};

$('#burn').onclick = async () => {
  if (active || !result) return;
  const job = begin();
  try {
    progress('Đang tải FFmpeg để nhúng phụ đề. Bước này có thể lâu hơn thời lượng video.', 1);
    job.media = new MediaEngine();
    const blob = await job.media.burn(result.file, result.segments, result.duration, (value) => progress('Đang xuất MP4 trên máy…', value));
    job.check();
    // Switch off the old media before revoking a previously exported MP4.
    $('#toggle-burn').checked = false;
    renderPlayer();
    revoke(result.burnURL);
    result.burnURL = makeURL(blob);
    $('#video-download').href = result.burnURL;
    $('#video-download').classList.remove('hidden');
    $('#toggle-burn').checked = true;
    renderPlayer();
    progress('MP4 có phụ đề đã sẵn sàng tải về.', 100, 'Hoàn tất');
  } catch (error) {
    progress(job.controller.signal.aborted ? 'Đã hủy xuất MP4. SRT/VTT vẫn tải được.' : `${error.message} Bạn vẫn có thể tải SRT/VTT.`, 0, 'Xuất MP4 dừng lại');
  } finally { finish(job); }
};

if (!window.isSecureContext || !window.Worker || !window.WebAssembly || !window.VTTCue) {
  $('#preflight').classList.remove('hidden');
  $('#preflight-list').textContent = 'Cần Chrome/Edge mới, HTTPS (GitHub Pages) hoặc localhost. Không mở bằng file://.';
  $('#inputs').disabled = true;
}
window.addEventListener('beforeunload', (event) => {
  if (active) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { active?.media?.dispose(); active?.ai?.dispose(); });
