const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// Keep seconds as numbers throughout the pipeline; never let a missing end
// timestamp keep the first cue visible for the entire video.
export function normalizeSegments(items, duration) {
  if (!finite(duration) || duration <= 0) throw new Error('Không đọc được thời lượng video.');
  const sorted = items.map((item) => ({
    start: item.start ?? item.timestamp?.[0],
    end: item.end ?? item.timestamp?.[1],
    text: String(item.text ?? '').trim(),
  })).filter((item) => finite(item.start) && item.start >= 0 && item.start < duration && item.text)
    .sort((a, b) => a.start - b.start);
  const result = [];
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    const next = sorted[i + 1]?.start ?? duration;
    const end = Math.min(duration, next, finite(item.end) ? item.end : Math.min(item.start + 6, next));
    const startMs = Math.round(item.start * 1000);
    const endMs = Math.round(end * 1000);
    if (endMs > startMs) result.push({ id: result.length + 1, start: startMs / 1000, end: endMs / 1000, text: item.text });
  }
  if (!result.length) throw new Error('Không tìm thấy lời thoại có mốc thời gian hợp lệ.');
  return result;
}

export function formatTime(seconds, separator = ',') {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}

export function parseSrt(text) {
  const seconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
  return text.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\s*\n/).flatMap((block) => {
    const lines = block.split('\n');
    const i = lines.findIndex((line) => line.includes('-->'));
    const match = lines[i]?.match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s+-->\s+(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/);
    if (!match) return [];
    return [{ start: seconds(...match.slice(1, 5)), end: seconds(...match.slice(5, 9)), text: lines.slice(i + 1).join('\n').trim() }];
  });
}

export const toSrt = (segments) => segments.map((s, i) => `${i + 1}\n${formatTime(s.start)} --> ${formatTime(s.end)}\n${s.text}\n`).join('\n');
const escapeVtt = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const toVtt = (segments) => 'WEBVTT\n\n' + segments.map((s, i) => `${i + 1}\n${formatTime(s.start, '.')} --> ${formatTime(s.end, '.')}\n${escapeVtt(s.text)}\n`).join('\n');

export function toAss(segments) {
  const stamp = (t) => {
    const cs = Math.max(0, Math.round(t * 100));
    return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const escape = (text) => text.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\r?\n/g, '\\N');
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans,34,&H00FFFFFF,&H000000FF,&H00111111,&H96000000,0,0,0,0,100,100,0,0,1,2,1,2,45,45,36,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` + segments.map((s) => `Dialogue: 0,${stamp(s.start)},${stamp(s.end)},Default,,0,0,0,,${escape(s.text)}`).join('\n') + '\n';
}

export function normalizeVietnamese(text) {
  return text.replace(/。/g, '.').replace(/[，、]/g, ',').replace(/！/g, '!').replace(/？/g, '?').trim();
}

// A single native TextTrack per player. Clear cues on each result, independently
// of the media URL, so translating the same video again also replaces subtitles.
export class SubtitleTrack {
  constructor(player) {
    this.track = player.addTextTrack('subtitles', 'Tiếng Việt', 'vi');
    this.track.mode = 'hidden';
  }
  clear() {
    this.track.mode = 'hidden';
    for (const cue of Array.from(this.track.cues || [])) this.track.removeCue(cue);
    this.track.mode = 'disabled';
  }
  replace(segments) {
    this.clear();
    this.track.mode = 'hidden';
    for (const s of segments) this.track.addCue(new VTTCue(s.start, s.end, escapeVtt(s.text)));
  }
  show(enabled) { this.track.mode = enabled ? 'showing' : 'disabled'; }
}
