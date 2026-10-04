import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSegments, formatTime, parseSrt, toSrt, toVtt, toAss } from '../src/subtitles.js';

test('first line cannot remain visible over following lines; missing ends are bounded', () => {
  const cues = normalizeSegments([
    { timestamp: [0, 100], text: 'Câu đầu' },
    { timestamp: [2, 3], text: 'Câu hai' },
    { timestamp: [4, null], text: 'Câu cuối' },
  ], 20);
  assert.deepEqual(cues.map(({ start, end }) => [start, end]), [[0, 2], [2, 3], [4, 10]]);
  assert.equal(cues.filter((c) => c.start <= 2.5 && c.end > 2.5)[0].text, 'Câu hai');
  assert.equal(cues.filter((c) => c.start <= 3.5 && c.end > 3.5).length, 0);
});

test('invalid/zero-length cues are dropped, time rounding never creates .1000', () => {
  const cues = normalizeSegments([
    { start: NaN, end: 1, text: 'invalid' },
    { start: 0, end: 0, text: 'empty' },
    { start: 1, end: 2, text: 'Tiếng Việt' },
  ], 3);
  assert.equal(cues.length, 1);
  assert.equal(formatTime(59.9999), '00:01:00,000');
  assert.equal(formatTime(3599.9999), '01:00:00,000');
});

test('SRT round-trip preserves independent timings and multiline Vietnamese', () => {
  const source = '\uFEFF1\r\n00:00:00,000 --> 00:00:01,250\r\nXin chào\r\nViệt Nam!\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nCảm ơn.';
  const segments = normalizeSegments(parseSrt(source), 4);
  assert.equal(segments.length, 2);
  assert.deepEqual(parseSrt(toSrt(segments)), segments.map(({ id, ...s }) => s));
  assert.match(toVtt(segments), /00:00:02\.000 --> 00:00:03\.000/);
  assert.match(toAss(segments), /0:00:02\.00,0:00:03\.00/);
});
