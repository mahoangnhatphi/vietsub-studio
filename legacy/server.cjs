// Historical Node/Electron implementation. The active app is client-only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const Busboy = require('busboy');

const ROOT = process.env.VTS_ROOT || __dirname;
const DATA_DIR = process.env.VTS_DATA_DIR || path.join(ROOT, 'storage');
const PUBLIC_DIR = path.join(ROOT, 'public');
const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const MODEL_DIR = path.join(VENDOR_DIR, 'models');
// Self-contained LibreTranslate (portable Python + models) shipped in vendor/.
const LIBRE_BUNDLE_DIR = path.join(VENDOR_DIR, 'libretranslate');
const LIBRE_BUNDLE_EXE = path.join(LIBRE_BUNDLE_DIR, 'Scripts', 'libretranslate.exe');
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 1_500 * 1024 * 1024;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
// Translation engine: auto (default) | openrouter | libretranslate | none.
// "auto" = OpenRouter when a key is supplied, otherwise LibreTranslate, with a
// fallback to the other engine whenever one of them fails.
const TRANSLATOR = (process.env.TRANSLATOR || 'auto').toLowerCase();
const LIBRE_URL = String(process.env.LIBRETRANSLATE_URL || `http://127.0.0.1:${process.env.LIBRETRANSLATE_PORT || 5000}`).replace(/\/+$/, '');
const LIBRE_KEY = process.env.LIBRETRANSLATE_KEY || '';
const LIBRE_SOURCE = process.env.LIBRETRANSLATE_SOURCE || '';
const jobs = new Map();

for (const directory of [JOBS_DIR, UPLOADS_DIR, MODEL_DIR]) fs.mkdirSync(directory, { recursive: true });

// Jobs live in memory only, so leftover folders are from previous runs. Only
// folders older than 6 hours are cleared, so a second running instance that is
// still processing a video never loses its files.
const STALE_JOB_MS = 6 * 60 * 60 * 1000;
for (const entry of fs.readdirSync(JOBS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const staleDir = path.join(JOBS_DIR, entry.name);
  try {
    if (Date.now() - fs.statSync(staleDir).mtimeMs > STALE_JOB_MS) fs.rmSync(staleDir, { recursive: true, force: true });
  } catch { /* ignore folders that vanished mid-sweep */ }
}

function findFile(directory, fileName) {
  if (!fs.existsSync(directory)) return null;
  const direct = path.join(directory, fileName);
  if (fs.existsSync(direct)) return direct;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = findFile(path.join(directory, entry.name), fileName);
    if (nested) return nested;
  }
  return null;
}

function findModel() {
  if (!fs.existsSync(MODEL_DIR)) return '';
  const models = fs.readdirSync(MODEL_DIR).filter((name) => name.endsWith('.bin') && fs.statSync(path.join(MODEL_DIR, name)).isFile());
  const rank = (name) => {
    const quality = ['large-v3', 'large-v2', 'large', 'medium', 'small', 'base', 'tiny', 'micro'].find((word) => name.includes(word));
    return quality ? ['large-v3', 'large-v2', 'large', 'medium', 'small', 'base', 'tiny', 'micro'].indexOf(quality) : 99;
  };
  const sorted = [...models].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return sorted.length ? path.join(MODEL_DIR, sorted[0]) : '';
}

const platformBinary = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const FFMPEG = process.env.FFMPEG_PATH || findFile(path.join(VENDOR_DIR, 'ffmpeg'), platformBinary('ffmpeg')) || 'ffmpeg';
const YT_DLP = process.env.YTDLP_PATH || findFile(path.join(VENDOR_DIR, 'ytdlp'), platformBinary('yt-dlp')) || 'yt-dlp';
const WHISPER = process.env.WHISPER_PATH || findFile(path.join(VENDOR_DIR, 'whisper'), platformBinary('whisper-cli')) || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL || findModel();
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || 'zh';
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS) || os.cpus().length || 4;

// LibreTranslate dùng mã riêng cho tiếng Trung: `zh` = giản thể, `zt` = phồn thể.
// Whisper đang ghi nhận ngôn ngữ gì thì dịch đúng ngôn ngữ đó.
const LIBRETRANSLATE_SOURCE = ({
  zh: 'zh', 'zh-cn': 'zh', 'zh-hans': 'zh', 'zh-sg': 'zh', 'cmn': 'zh',
  'zh-tw': 'zt', 'zh-hk': 'zt', 'zh-mo': 'zt', 'zh-hant': 'zt'
})[(WHISPER_LANGUAGE || 'zh').toLowerCase()] || WHISPER_LANGUAGE;

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.srt': 'application/x-subrip; charset=utf-8' })[extension] || 'application/octet-stream';
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function safePath(root, name) {
  const target = path.resolve(root, name);
  return target.startsWith(path.resolve(root) + path.sep) ? target : null;
}

function commandExists(command, args = ['-version']) {
  const probe = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
  if (probe.error) return false;
  return probe.status === 0 || probe.status === 1;
}

let ytDlpProbe = null;
const ytDlpAvailable = () => (ytDlpProbe ??= commandExists(YT_DLP, ['--version']));

function missingTools() {
  const missing = [];
  if (!commandExists(FFMPEG)) missing.push(`FFmpeg không tìm thấy (${FFMPEG})`);
  if (!commandExists(WHISPER)) missing.push(`Whisper CLI không tìm thấy (${WHISPER})`);
  if (!WHISPER_MODEL || !fs.existsSync(WHISPER_MODEL)) missing.push('Thiếu model Whisper trong vendor\\models (tải ggml-small.bin)');
  return missing;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const task = spawn(command, args, { cwd: options.cwd, windowsHide: true, shell: false });
    let stderr = '';
    task.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    task.on('error', (error) => reject(new Error(error.code === 'ENOENT' ? `Không tìm thấy chương trình: ${command}.` : error.message)));
    task.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}. ${stderr.trim()}`)));
  });
}

function setJob(job, state, progress, message, extra = {}) {
  Object.assign(job, { state, progress, message, updatedAt: new Date().toISOString(), ...extra });
}

// Jobs start at different points: uploaded videos begin at 0, link jobs already
// spent 55% of the bar on downloading, so every later phase is scaled to fit.
function phase(job, fraction) {
  const base = job.base || 0;
  return Math.max(base, Math.min(99, Math.round(base + (100 - base) * fraction)));
}

function escapeAss(text) {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, '\\N');
}

function formatTime(seconds, separator = ',') {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const milliseconds = Math.round((value - Math.floor(value)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(milliseconds).padStart(3, '0')}`;
}

function parseSrt(content) {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  return normalized.split(/\n{2,}/).map((block, index) => {
    const lines = block.split('\n');
    const timeline = lines.find((line) => line.includes('-->'));
    if (!timeline) return null;
    const [startText, endText] = timeline.split('-->').map((value) => value.trim());
    const toSeconds = (value) => {
      const [clock, fraction = '0'] = value.replace(',', '.').split('.');
      const [h, m, s] = clock.split(':').map(Number);
      return h * 3600 + m * 60 + s + Number(`0.${fraction}`);
    };
    const textStart = lines.indexOf(timeline) + 1;
    return { id: index + 1, start: toSeconds(startText), end: toSeconds(endText), text: lines.slice(textStart).join(' ').trim() };
  }).filter((segment) => segment && segment.text);
}

function toSrt(segments) {
  return segments.map((segment, index) => `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${segment.text}\n`).join('\n');
}

function toAss(segments) {
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Vietnamese,Arial,50,&H00FFFFFF,&H000000FF,&H00111111,&H96000000,1,0,0,0,100,100,0,0,1,3,1,2,70,70,55,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const stamp = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const hundredths = Math.floor((seconds - Math.floor(seconds)) * 100);
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
  };
  return header + segments.map((segment) => `Dialogue: 0,${stamp(segment.start)},${stamp(segment.end)},Vietnamese,,0,0,0,,${escapeAss(segment.text)}`).join('\n') + '\n';
}

function toVtt(srtContent) {
  const body = srtContent.replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  return `WEBVTT\n\n${body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}\n`;
}

async function fetchCompletion(apiKey, prompt) {
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': `http://localhost:${PORT}`, 'X-Title': 'VietSub Studio' }, body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'system', content: 'You translate subtitle text only. Respond with valid JSON and no Markdown.' }, { role: 'user', content: prompt }], temperature: 0.2 }) };
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    let response;
    try { response = await fetch('https://openrouter.ai/api/v1/chat/completions', request); } catch (error) { lastError = new Error(`Không thể kết nối OpenRouter: ${error.message}`); continue; }
    const raw = await response.text();
    if (response.status === 429 || response.status >= 500) { lastError = new Error(`OpenRouter đang bận (${response.status}), sẽ thử lại: ${raw.slice(0, 300)}`); continue; }
    if (!response.ok) throw new Error(`OpenRouter từ chối yêu cầu (${response.status}): ${raw.slice(0, 500)}`);
    let payload;
    try { payload = JSON.parse(raw); } catch { lastError = new Error('OpenRouter trả về dữ liệu không đọc được.'); continue; }
    const content = payload?.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map((part) => part?.text || '').join('') : String(content || '');
    if (!text.trim()) { lastError = new Error('OpenRouter trả về nội dung rỗng.'); continue; }
    return text.trim();
  }
  throw lastError || new Error('Dịch phụ đề bằng OpenRouter thất bại.');
}

function parseJsonArray(content) {
  const clean = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const items = JSON.parse(clean);
    return Array.isArray(items) ? items : null;
  } catch {
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start === -1 || end <= start) return null;
    try {
      const items = JSON.parse(clean.slice(start, end + 1));
      return Array.isArray(items) ? items : null;
    } catch { return null; }
  }
}

function libreSourceLanguage() {
  if (LIBRE_SOURCE) return LIBRE_SOURCE;
  const lang = String(WHISPER_LANGUAGE || '').toLowerCase();
  if (!lang || lang === 'auto') return ''; // detect it from the text instead
  if (lang.startsWith('zh')) return 'zh'; // LibreTranslate resolves zh to the installed variant
  return lang;
}

// LibreTranslate requires an explicit source, so detect it once per job when
// Whisper was set to auto-detect the input language.
async function detectLibreLanguage(text) {
  try {
    const response = await fetch(`${LIBRE_URL}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ q: String(text || '').slice(0, 400) })
    });
    if (response.ok) {
      const data = await response.json();
      const code = data?.detectedLanguage?.language;
      if (typeof code === 'string' && code) return code;
    }
  } catch { /* fall through to the default */ }
  return 'zh';
}

async function probeLibreTranslate(timeoutMs = 2500) {
  try {
    const response = await fetch(`${LIBRE_URL}/languages`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const list = await response.json();
    return Array.isArray(list) ? list : null;
  } catch { return null; }
}

function pythonInstalls() {
  const roots = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean);
  const found = [];
  for (const root of roots) {
    const base = path.join(root, 'Programs', 'Python');
    if (!fs.existsSync(base)) continue;
    for (const dir of fs.readdirSync(base)) {
      const python = path.join(base, dir, 'python.exe');
      if (fs.existsSync(python)) found.push(python);
      const cli = path.join(base, dir, 'Scripts', 'libretranslate.exe');
      if (fs.existsSync(cli)) found.push(cli);
    }
  }
  return found;
}

function findLibreCommand() {
  const candidates = [];
  if (process.env.LIBRETRANSLATE_CMD) candidates.push(process.env.LIBRETRANSLATE_CMD.trim().split(/\s+/).filter(Boolean));
  if (fs.existsSync(LIBRE_BUNDLE_EXE)) candidates.push([LIBRE_BUNDLE_EXE]); // bundled, works offline
  candidates.push(['libretranslate']);
  // PATH may be stale (e.g. Python installed after the app started), so also
  // probe the usual per-user Python install locations.
  for (const location of pythonInstalls()) {
    if (location.toLowerCase().endsWith('libretranslate.exe')) candidates.push([location]);
    else candidates.push([location, '-m', 'libretranslate']);
  }
  candidates.push(['py', '-m', 'libretranslate'], ['python', '-m', 'libretranslate'], ['python3', '-m', 'libretranslate']);

  for (const candidate of candidates) {
    const [command, ...args] = candidate;
    try {
      const probe = spawnSync(command, [...args, '--help'], { timeout: 30000, stdio: 'ignore', windowsHide: true });
      if (!probe.error && probe.status === 0) return candidate;
    } catch { /* try the next candidate */ }
  }
  return null;
}

let libreProcess = null;
let libreStartPromise = null;
let libreCommandCache; // undefined = not probed yet, null = not installed

function cachedLibreCommand() {
  if (libreCommandCache === undefined) {
    try { libreCommandCache = findLibreCommand(); } catch { libreCommandCache = null; }
  }
  return libreCommandCache;
}

// LibreTranslate normally runs as its own service; start it on demand when it
// is installed locally and the configured URL is still unreachable.
async function ensureLibreTranslate() {
  if (await probeLibreTranslate()) return true;
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(LIBRE_URL)) return false;
  if (libreStartPromise) return libreStartPromise;

  libreStartPromise = (async () => {
    const command = cachedLibreCommand();
    if (!command) return false;
    const [binary, ...args] = command;
    const startArgs = [...args, '--host', '127.0.0.1', '--port', String(new URL(LIBRE_URL).port || 5000), '--disable-files-translation', '--disable-web-ui'];
    if (process.env.LIBRETRANSLATE_LOAD_ONLY) startArgs.push('--load-only', process.env.LIBRETRANSLATE_LOAD_ONLY);
    const spawnEnv = { ...process.env };
    if (path.resolve(binary).toLowerCase() === path.resolve(LIBRE_BUNDLE_EXE).toLowerCase()) {
      // The bundle is self-contained: point Argos at its own data/config/cache
      // so nothing is written to (or read from) the user profile.
      spawnEnv.XDG_DATA_HOME = path.join(LIBRE_BUNDLE_DIR, 'data');
      spawnEnv.XDG_CONFIG_HOME = path.join(LIBRE_BUNDLE_DIR, 'data');
      spawnEnv.XDG_CACHE_HOME = path.join(LIBRE_BUNDLE_DIR, 'cache');
    }
    libreProcess = spawn(binary, startArgs, { windowsHide: true, stdio: 'ignore', env: spawnEnv });
    libreProcess.on('error', () => { libreProcess = null; });
    libreProcess.on('exit', () => { libreProcess = null; });
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline && libreProcess) {
      if (await probeLibreTranslate(1500)) return true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return false;
  })()
    .catch(() => false)
    .finally(() => { libreStartPromise = null; });

  return libreStartPromise;
}

// Argos (LibreTranslate) sometimes leaves full-width punctuation behind.
function normalizeVietnamese(text) {
  return String(text)
    .replace(/。/g, '.').replace(/[，、]/g, ',').replace(/：/g, ':').replace(/；/g, ';')
    .replace(/！/g, '!').replace(/？/g, '?').replace(/（/g, '(').replace(/）/g, ')')
    .replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

async function translateWithLibreTranslate(segments) {
  if (!(await ensureLibreTranslate())) {
    throw new Error(`LibreTranslate không phản hồi tại ${LIBRE_URL} (cài: pip install libretranslate, hoặc đặt LIBRETRANSLATE_URL).`);
  }
  const translated = new Map();
  let source = libreSourceLanguage();
  if (!source) source = await detectLibreLanguage(segments[0]?.text);
  const size = 25;
  for (let index = 0; index < segments.length; index += size) {
    const chunk = segments.slice(index, index + size);
    const payload = { q: chunk.map((segment) => segment.text), source, target: 'vi', format: 'text' };
    if (LIBRE_KEY) payload.api_key = LIBRE_KEY;
    const response = await fetch(`${LIBRE_URL}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`LibreTranslate lỗi ${response.status}: ${raw.slice(0, 300)}`);
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('LibreTranslate trả về dữ liệu không hợp lệ.'); }
    if (data.error) throw new Error(`LibreTranslate: ${data.error}`);
    const values = Array.isArray(data.translatedText) ? data.translatedText : [data.translatedText];
    if (values.length !== chunk.length) throw new Error(`LibreTranslate trả ${values.length}/${chunk.length} dòng.`);
    chunk.forEach((segment, offset) => {
      const text = normalizeVietnamese(values[offset] ?? '');
      if (text) translated.set(segment.id, text);
    });
  }
  for (const segment of segments) if (!translated.get(segment.id)) throw new Error('Bản dịch của LibreTranslate còn thiếu dòng.');
  return segments.map((segment) => ({ ...segment, text: translated.get(segment.id) }));
}

function enginePlan(engine, hasKey) {
  const mode = String(engine || TRANSLATOR || 'auto').toLowerCase();
  if (mode === 'openrouter') return ['openrouter'];
  if (mode === 'libretranslate') return ['libretranslate'];
  if (mode === 'none') return ['none'];
  return hasKey ? ['openrouter', 'libretranslate'] : ['libretranslate', 'openrouter'];
}

const VALID_ENGINES = new Set(['auto', 'openrouter', 'libretranslate', 'none']);
function normalizeEngine(value) {
  const engine = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return VALID_ENGINES.has(engine) ? engine : '';
}

async function translateWithOpenRouter(segments, apiKey) {
  const batches = [];
  for (let index = 0; index < segments.length; index += 35) batches.push(segments.slice(index, index + 35));
  const translated = new Map();
  for (const batch of batches) {
    const prompt = `Translate each subtitle into natural Vietnamese. Preserve each id exactly. Keep the result concise for on-screen subtitles. Do not alter timestamps. Return ONLY a JSON array of objects with fields id and text.\n\n${JSON.stringify(batch.map(({ id, text }) => ({ id, text })))}`;
    const items = parseJsonArray(await fetchCompletion(apiKey, prompt));
    if (!items) throw new Error('OpenRouter không trả về JSON phụ đề hợp lệ.');
    const validIds = new Set(batch.map((segment) => segment.id));
    for (const item of items) if (validIds.has(item?.id) && typeof item.text === 'string' && item.text.trim()) translated.set(item.id, item.text.trim());
    if (translated.size < batch.length) throw new Error(`Bản dịch chưa đủ (${translated.size}/${batch.length} dòng).`);
  }
  return segments.map((segment) => ({ ...segment, text: translated.get(segment.id) }));
}

async function translate(segments, apiKey, engine) {
  const plan = enginePlan(engine, Boolean(apiKey));
  if (plan.includes('none')) return segments; // keep the source language subtitles
  const problems = [];
  for (const name of plan) {
    try {
      if (name === 'openrouter') {
        if (!apiKey) throw new Error('chưa có OpenRouter API key.');
        return await translateWithOpenRouter(segments, apiKey);
      }
      return await translateWithLibreTranslate(segments);
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  throw new Error(`Không dịch được — ${problems.join(' · ')}`);
}

const INPUT_PATTERN = /^input\.(mp4|mkv|webm|mov|m4v|flv|ts|avi)$/i;

function findInputFile(dir) {
  const files = fs.readdirSync(dir).filter((name) => INPUT_PATTERN.test(name));
  if (!files.length) return null;
  const largest = files.sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0];
  return path.join(dir, largest);
}

function downloadLink(job, url) {
  const limit = job.base || 55;
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--no-warnings', '--newline', '--no-progress',
      '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG,
      '-o', path.join(job.dir, 'input.%(ext)s'),
      url
    ];
    const task = spawn(YT_DLP, args, { windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let lastProgress = 4;
    const handleLine = (line) => {
      const text = line.trim();
      if (!text) return;
      const match = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(text);
      if (match) {
        const percent = Number(match[1]);
        const value = Math.min(limit - 2, Math.max(4, Math.round(4 + (limit - 6) * (percent / 100))));
        if (value > lastProgress) {
          lastProgress = value;
          setJob(job, 'downloading', value, `Đang tải video từ liên kết… ${Math.round(percent)}%`);
        }
        return;
      }
      if (/^\[(merger|ffmpeg|Fixup|M3U8|Metadata|EmbedSubtitle|ExtractAudio)\]/i.test(text)) {
        setJob(job, 'downloading', limit - 2, 'Đang ghép và chuyển định dạng video…');
        return;
      }
      if (text.startsWith('ERROR') || text.startsWith('WARNING')) stderr = `${stderr}\n${text}`.slice(-4000);
    };
    task.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-8000);
      pending += String(chunk);
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop();
      lines.forEach(handleLine);
    });
    task.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    task.on('error', (error) => reject(new Error(error.code === 'ENOENT' ? `Không tìm thấy yt-dlp (${YT_DLP}).` : error.message)));
    task.on('close', (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp thất bại (mã ${code}): ${(stderr.trim() || stdout.trim()).slice(-600)}`));
      resolve(findInputFile(job.dir));
    });
  });
}

async function processJob(job, apiKey) {
  try {
    const missing = missingTools();
    if (missing.length) throw new Error(`Thiết bị chưa đủ điều kiện: ${missing.join('; ')}.`);

    // Fail fast when the only usable engine is LibreTranslate: warm it up before
    // spending minutes on audio extraction and transcription.
    const plan = enginePlan(job.engine, Boolean(apiKey));
    if (plan.includes('libretranslate') && !(await probeLibreTranslate())) {
      setJob(job, 'processing', 3, 'Đang khởi động LibreTranslate…');
      if (!(await ensureLibreTranslate()) && !plan.includes('openrouter')) {
        throw new Error(`LibreTranslate chưa sẵn sàng tại ${LIBRE_URL}. Cài bằng "pip install libretranslate" hoặc đặt LIBRETRANSLATE_URL, hoặc nhập OpenRouter API key.`);
      }
    }

    if (job.link) {
      if (!ytDlpAvailable()) throw new Error(`Không tìm thấy yt-dlp (${YT_DLP}) — cần để tải video từ liên kết.`);
      setJob(job, 'downloading', 4, 'Đang tải video từ liên kết…');
      job.inputPath = await downloadLink(job, job.link);
      if (!job.inputPath) throw new Error('Không tìm thấy tệp video sau khi tải từ liên kết.');
    }

    setJob(job, 'processing', phase(job, 0.12), 'Đang trích xuất âm thanh…');
    await run(FFMPEG, ['-y', '-i', job.inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', job.audioPath]);

    setJob(job, 'processing', phase(job, 0.38), `Đang nhận diện lời thoại (${WHISPER_LANGUAGE})…`);
    await run(WHISPER, ['-m', WHISPER_MODEL, '-t', String(WHISPER_THREADS), '-f', job.audioPath, '-l', WHISPER_LANGUAGE, '-osrt', '-of', path.join(job.dir, 'source')]);
    const sourceSrt = path.join(job.dir, 'source.srt');
    if (!fs.existsSync(sourceSrt)) throw new Error('Whisper không tạo ra tệp phụ đề SRT.');
    const sourceSegments = parseSrt(fs.readFileSync(sourceSrt, 'utf8'));
    if (!sourceSegments.length) throw new Error('Không phát hiện lời thoại nào trong video.');

    setJob(job, 'processing', phase(job, 0.62), 'Đang dịch phụ đề sang tiếng Việt…');
    const vietnameseSegments = await translate(sourceSegments, apiKey, job.engine);
    fs.writeFileSync(job.srtPath, toSrt(vietnameseSegments), 'utf8');
    fs.writeFileSync(job.assPath, toAss(vietnameseSegments), 'utf8');
    setJob(job, 'processing', phase(job, 0.72), 'Phụ đề đã dịch. Đang nhúng vào video…', { subtitlesReady: true });

    await run(FFMPEG, ['-y', '-i', path.basename(job.inputPath), '-vf', `ass=${path.basename(job.assPath)}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', job.outputPath], { cwd: job.dir });
    setJob(job, 'complete', 100, 'Phụ đề tiếng Việt đã sẵn sàng.', { outputReady: true, subtitlesReady: true });
  } catch (error) {
    setJob(job, 'error', 0, error.message || 'Xử lý video thất bại.');
  }
}

function serveFile(response, filePath, download = false, contentType = null) {
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return json(response, 404, { error: 'Không tìm thấy tệp.' });
    const headers = { 'Content-Type': contentType || mimeType(filePath), 'Accept-Ranges': 'bytes' };
    if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
    const range = response.req?.headers?.range;
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (!Number.isFinite(start) || start >= stat.size || start > end) {
        response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return response.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
      response.writeHead(206, headers);
      return fs.createReadStream(filePath, { start, end }).pipe(response);
    }
    headers['Content-Length'] = stat.size;
    response.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(response);
  });
}

function makeJob(id, dir, base = 0, link = null, engine = '') {
  return {
    id, dir, base, link, engine,
    inputPath: null,
    audioPath: path.join(dir, 'audio.wav'),
    srtPath: path.join(dir, 'vietnamese.srt'),
    assPath: path.join(dir, 'vietnamese.ass'),
    outputPath: path.join(dir, 'vietnamese-subtitles.mp4'),
    state: 'queued',
    progress: 2,
    message: 'Video đã tải lên. Đang chờ xử lý…',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputReady: false,
    subtitlesReady: false
  };
}

function registerJob(job, response, apiKey) {
  jobs.set(job.id, job);
  json(response, 202, { id: job.id });
  void processJob(job, apiKey);
}

function createJob(request, response) {
  const apiKey = typeof request.headers['x-openrouter-key'] === 'string' ? request.headers['x-openrouter-key'].trim() : '';
  const engine = normalizeEngine(request.headers['x-translate-engine']);
  if (engine === 'openrouter' && !apiKey) return json(response, 400, { error: 'Đã chọn OpenRouter nên cần nhập API key.' });
  let busboy;
  try {
    busboy = Busboy({ headers: request.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
  } catch (error) {
    return json(response, 400, { error: error.message || 'Danh mục tải lên không hợp lệ.' });
  }
  const id = crypto.randomUUID();
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  let uploadPath;
  let uploaded = false;
  let uploadFinished = false;
  let streamClosed = false;
  let started = false;
  let rejected = false;
  let writeStream;
  const reject = (status, message) => {
    if (rejected) return;
    rejected = true;
    request.unpipe(busboy);
    request.resume();
    writeStream?.destroy();
    fs.rm(dir, { recursive: true, force: true }, () => {});
    if (!response.writableEnded) json(response, status, { error: message });
  };
  const maybeStart = () => {
    if (started || rejected || !uploadFinished || !streamClosed) return;
    started = true;
    const job = makeJob(id, dir, 0, null, engine);
    job.inputPath = uploadPath;
    registerJob(job, response, String(apiKey).trim());
  };
  busboy.on('file', (fieldname, file, info) => {
    if (fieldname !== 'video' || uploaded) { file.resume(); return; }
    const originalName = path.basename(info.filename || 'video.mp4');
    const extension = path.extname(originalName).toLowerCase();
    if (!['.mp4', '.mov', '.mkv', '.webm'].includes(extension)) { file.resume(); return; }
    uploadPath = path.join(dir, `input${extension}`);
    uploaded = true;
    writeStream = fs.createWriteStream(uploadPath);
    writeStream.on('error', () => reject(500, 'Không thể lưu video tải lên.'));
    writeStream.on('close', () => { streamClosed = true; maybeStart(); });
    file.on('limit', () => reject(413, 'Video vượt quá giới hạn 1.5 GB.'));
    file.pipe(writeStream);
  });
  busboy.on('error', (error) => reject(400, error.message || 'Danh mục tải lên không hợp lệ.'));
  busboy.on('finish', () => {
    uploadFinished = true;
    if (rejected) return;
    if (!uploaded || !uploadPath || !writeStream) return reject(400, 'Hãy chọn một video hợp lệ: MP4, MOV, MKV hoặc WebM.');
    maybeStart();
  });
  request.on('aborted', () => reject(400, 'Quá trình tải lên bị gián đoạn.'));
  request.pipe(busboy);
}

function createLinkJob(request, response) {
  const apiKey = typeof request.headers['x-openrouter-key'] === 'string' ? request.headers['x-openrouter-key'].trim() : '';
  let body = '';
  let tooLarge = false;
  request.on('data', (chunk) => {
    if (tooLarge) return;
    body += chunk;
    if (body.length > 8192) { tooLarge = true; body = ''; }
  });
  request.on('error', () => { if (!response.writableEnded) json(response, 400, { error: 'Đọc yêu cầu thất bại.' }); });
  request.on('end', () => {
    if (response.writableEnded) return;
    if (tooLarge) return json(response, 413, { error: 'Dữ liệu gửi lên quá lớn.' });
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { return json(response, 400, { error: 'Dữ liệu yêu cầu không hợp lệ.' }); }
    const engine = normalizeEngine(payload.engine);
    if (engine === 'openrouter' && !apiKey) return json(response, 400, { error: 'Đã chọn OpenRouter nên cần nhập API key.' });
    const raw = typeof payload.url === 'string' ? payload.url.trim() : '';
    let parsed;
    try { parsed = new URL(raw); } catch { return json(response, 400, { error: 'Liên kết không hợp lệ. Hãy dán địa chỉ http/https đầy đủ.' }); }
    if (!/^https?:$/.test(parsed.protocol)) return json(response, 400, { error: 'Chỉ chấp nhận liên kết http hoặc https.' });
    if (!ytDlpAvailable()) return json(response, 500, { error: `Không tìm thấy yt-dlp (${YT_DLP}).` });
    const id = crypto.randomUUID();
    const dir = path.join(JOBS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const job = makeJob(id, dir, 55, parsed.href, engine);
    job.state = 'downloading';
    job.progress = 3;
    job.message = 'Đang tải video từ liên kết…';
    registerJob(job, response, apiKey);
  });
}

function jobUrls(job) {
  const base = `/api/jobs/${job.id}`;
  return {
    videoUrl: job.inputPath ? `${base}/video` : null,
    vttUrl: job.subtitlesReady ? `${base}/vtt` : null,
    burnUrl: job.outputReady ? `${base}/burn` : null,
    downloadUrl: job.outputReady ? `${base}/download` : null,
    subtitlesUrl: job.subtitlesReady ? `${base}/subtitles` : null
  };
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/api/health') {
    void (async () => {
      const libre = await probeLibreTranslate(1500);
      json(response, 200, {
        ok: missingTools().length === 0,
        missing: missingTools(),
        linkSupport: ytDlpAvailable(),
        ytDlp: YT_DLP,
        ffmpeg: FFMPEG,
        whisper: WHISPER,
        whisperModel: WHISPER_MODEL,
        language: WHISPER_LANGUAGE,
        model: OPENROUTER_MODEL,
        translator: {
          engine: TRANSLATOR,
          openrouter: OPENROUTER_MODEL,
          libretranslate: {
            url: LIBRE_URL,
            available: Boolean(libre),
            installed: libreCommandCache === undefined ? null : Boolean(libreCommandCache),
            source: libreSourceLanguage() || 'auto',
            languages: libre ? libre.map((item) => item.code) : []
          }
        }
      });
    })();
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/jobs/link') return createLinkJob(request, response);
  if (request.method === 'POST' && url.pathname === '/api/jobs') return createJob(request, response);
  const statusMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
  if (request.method === 'GET' && statusMatch) {
    const job = jobs.get(statusMatch[1]);
    if (!job) return json(response, 404, { error: 'Không tìm thấy job. Job chỉ tồn tại trong khi server đang chạy.' });
    return json(response, 200, { id: job.id, state: job.state, progress: job.progress, message: job.message, outputReady: job.outputReady, subtitlesReady: job.subtitlesReady, ...jobUrls(job) });
  }
  const fileMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)\/(video|vtt|burn|download|subtitles)$/i);
  if (request.method === 'GET' && fileMatch) {
    const job = jobs.get(fileMatch[1]);
    if (!job) return json(response, 404, { error: 'Không tìm thấy job.' });
    const kind = fileMatch[2].toLowerCase();
    if (kind === 'video') {
      if (!job.inputPath) return json(response, 404, { error: 'Video gốc chưa sẵn sàng.' });
      return serveFile(response, job.inputPath);
    }
    if (kind === 'vtt') {
      if (!job.subtitlesReady || !fs.existsSync(job.srtPath)) return json(response, 404, { error: 'Phụ đề chưa sẵn sàng.' });
      response.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
      return response.end(toVtt(fs.readFileSync(job.srtPath, 'utf8')));
    }
    if (kind === 'subtitles') {
      if (!job.subtitlesReady || !fs.existsSync(job.srtPath)) return json(response, 404, { error: 'Phụ đề chưa sẵn sàng.' });
      return serveFile(response, job.srtPath, true);
    }
    if (!job.outputReady || !fs.existsSync(job.outputPath)) return json(response, 404, { error: 'Video chưa được dựng xong.' });
    return serveFile(response, job.outputPath, kind === 'download');
  }
  if (request.method === 'GET') {
    const fileName = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = safePath(PUBLIC_DIR, fileName);
    if (filePath && fs.existsSync(filePath)) return serveFile(response, filePath);
  }
  json(response, 404, { error: 'Không tìm thấy.' });
});

const ready = new Promise((resolve, reject) => {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${PORT} đang được dùng. Đặt PORT=<khác> rồi chạy lại.`);
    reject(error);
  });
  server.listen(PORT, () => {
    const missing = missingTools();
    const port = server.address().port;
    console.log(`VietSub Studio đang chạy tại http://localhost:${port}`);
    console.log(`FFmpeg: ${commandExists(FFMPEG) ? FFMPEG : 'THIẾU'}`);
    console.log(`yt-dlp: ${ytDlpAvailable() ? YT_DLP : 'THIẾU (sẽ không tải được từ liên kết)'}`);
    console.log(`Whisper: ${commandExists(WHISPER) ? WHISPER : 'THIẾU'}`);
    console.log(`Model: ${WHISPER_MODEL && fs.existsSync(WHISPER_MODEL) ? WHISPER_MODEL : 'THIẾU (đặt ggml-*.bin vào vendor\\models)'}`);
    console.log(`Ngôn ngữ: ${WHISPER_LANGUAGE} (${WHISPER_THREADS} luồng) · Engine dịch: ${TRANSLATOR}${TRANSLATOR === 'auto' ? ' (có key → OpenRouter, không → LibreTranslate)' : ''} · Model OpenRouter: ${OPENROUTER_MODEL}`);
    if (missing.length) console.warn(`Chưa sẵn sàng: ${missing.join('; ')}`);
    // Probe LibreTranslate off the critical path so /api/health can tell the UI
    // whether a key is needed, without blocking page loads.
    setTimeout(() => {
      const command = cachedLibreCommand();
      console.log(`LibreTranslate: ${command ? `${command.join(' ')} (tự khởi động khi dịch)` : 'chưa cài (dịch cần OpenRouter key)'}`);
    }, 50);
    resolve(port);
  });
});

module.exports = { server, ready };
