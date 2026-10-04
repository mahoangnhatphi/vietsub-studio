import { test, expect } from '@playwright/test';
import path from 'node:path';

const video = path.resolve('tests/fixtures/video.mp4');
const srt = (text) => ({ name: 'test.srt', mimeType: 'text/plain', buffer: Buffer.from(text) });
async function createResult(page, captions) {
  await page.locator('#language').selectOption('vi');
  await page.locator('#video').setInputFiles(video);
  await page.locator('#source-srt').setInputFiles(srt(captions));
  await page.locator('#submit').click();
  await expect(page.locator('#state-title')).toHaveText('Hoàn tất');
}
async function seek(page, time) {
  await page.locator('#player').evaluate(async (player, seconds) => {
    if (player.readyState < 1) await new Promise((r) => player.addEventListener('loadedmetadata', r, { once: true }));
    await new Promise((r) => { player.addEventListener('seeked', r, { once: true }); player.currentTime = seconds; });
  }, time);
}
const activeText = (page) => page.locator('#player').evaluate((v) => Array.from(v.textTracks[0].activeCues || []).map((c) => c.text).join('|'));

test('subpath + cue transitions, gaps, replay, toggles, and replacement on a second job', async ({ page }) => {
  const apiRequests = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) apiRequests.push(r.url()); });
  await page.goto('./');
  await expect(page.locator('#result-card')).toBeHidden();
  await createResult(page, '1\n00:00:00,000 --> 00:00:06,000\nCâu đầu\n\n2\n00:00:02,000 --> 00:00:03,000\nCâu hai\n\n3\n00:00:04,000 --> 00:00:05,000\nCâu ba');
  await seek(page, .5);
  await expect.poll(() => activeText(page)).toBe('Câu đầu');
  await seek(page, 2.5);
  await expect.poll(() => activeText(page)).toBe('Câu hai');
  await seek(page, 3.5);
  await expect.poll(() => activeText(page)).toBe('');
  await seek(page, 4.5);
  await expect.poll(() => activeText(page)).toBe('Câu ba');
  await seek(page, .25);
  await expect.poll(() => activeText(page)).toBe('Câu đầu');
  await page.locator('#toggle-subs').uncheck();
  expect(await page.locator('#player').evaluate((v) => v.textTracks[0].mode)).toBe('disabled');
  await page.locator('#toggle-subs').check();
  await createResult(page, '1\n00:00:00,000 --> 00:00:01,000\nPhụ đề mới');
  await seek(page, .5);
  await expect.poll(() => activeText(page)).toBe('Phụ đề mới');
  expect(await page.locator('#player').evaluate((v) => v.textTracks[0].cues.length)).toBe(1);
  expect(apiRequests).toEqual([]);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
});

test('single-thread ffmpeg burns Vietnamese subtitles and can switch back to soft cues', async ({ page }) => {
  await page.goto('./');
  await createResult(page, '1\n00:00:00,000 --> 00:00:02,000\nXin chào Việt Nam!\n\n2\n00:00:03,000 --> 00:00:05,000\nCảm ơn bạn.');
  await page.locator('#burn').click();
  await expect(page.locator('#video-download')).toBeVisible({ timeout: 90000 });
  await expect(page.locator('#toggle-burn')).toBeChecked();
  expect(await page.locator('#player').evaluate((v) => v.textTracks[0].mode)).toBe('disabled');
  const size = await page.locator('#video-download').evaluate(async (a) => (await (await fetch(a.href)).blob()).size);
  expect(size).toBeGreaterThan(1000);
  await page.locator('#toggle-burn').uncheck();
  await seek(page, 3.5);
  await expect.poll(() => activeText(page)).toBe('Cảm ơn bạn.');
});

test('cancel a pending runtime download, then successfully process another job', async ({ page }) => {
  await page.route('**/runtime/ffmpeg/ffmpeg-core.wasm', async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.abort(); });
  await page.goto('./');
  await page.locator('#video').setInputFiles(video);
  await page.locator('#submit').click();
  await expect(page.locator('#cancel')).toBeVisible();
  await page.locator('#cancel').click();
  await expect(page.locator('#state-title')).toHaveText('Đã hủy');
  await createResult(page, '1\n00:00:00,000 --> 00:00:01,000\nLần xử lý mới');
});

test('real browser Whisper + local translation (opt-in model download)', async ({ page, context }) => {
  test.skip(!process.env.RUN_MODEL_TEST, 'Set RUN_MODEL_TEST=1 to download and run the real models.');
  test.setTimeout(900000);
  page.on('console', (msg) => { if (msg.type() === 'error') console.log(msg.text()); });
  page.on('response', (response) => { if (response.status() >= 400) console.log('HTTP', response.status(), response.url()); });
  await page.goto('./');
  await page.locator('#video').setInputFiles(path.resolve('tests/fixtures/chinese.mp4'));
  await page.locator('#submit').click();
  await expect(page.locator('#cancel')).toBeHidden({ timeout: 850000 });
  await expect(page.locator('#result-card')).toBeVisible();
  await expect(page.locator('#state-title')).toHaveText('Hoàn tất');
  const cues = await page.locator('#player').evaluate((v) => Array.from(v.textTracks[0].cues).map((c) => ({ start: c.startTime, end: c.endTime, text: c.text })));
  console.log('BROWSER_MODEL_RESULT', JSON.stringify(cues));
  expect(cues.length).toBeGreaterThan(0);
  expect(cues.every((c) => c.end > c.start && c.text.trim())).toBe(true);
  // Repeat with the browser network offline. Models + WASM + application shell
  // must all come from browser caches, and optional OpenRouter must fall back.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await page.locator('#video').setInputFiles(path.resolve('tests/fixtures/chinese.mp4'));
  await page.locator('#api-key').fill('offline-test-key');
  await page.locator('#submit').click();
  await expect(page.locator('#cancel')).toBeHidden({ timeout: 300000 });
  await expect(page.locator('#result-card')).toBeVisible();
  await expect(page.locator('#result-note')).toContainText('OpenRouter lỗi');
  await expect(page.locator('#state-title')).toHaveText('Hoàn tất');
  console.log('OFFLINE_MODEL_FALLBACK_OK');
});
