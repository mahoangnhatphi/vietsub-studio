# VietSub Studio — client-only

Tạo phụ đề tiếng Việt **ngay trong trình duyệt**, deploy bằng tệp tĩnh lên GitHub Pages. Không chạy Node backend, Python, LibreTranslate HTTP, FFmpeg native hay Electron ở máy người dùng.

## Cách hoạt động

1. Chọn video trên máy, hoặc URL **trực tiếp tới video có CORS**.
2. FFmpeg WebAssembly trích âm thanh 16 kHz ngay trên máy.
3. Whisper multilingual (`tiny` mặc định, tùy chọn `base`) nhận lời thoại trong Web Worker.
4. Model ONNX dịch Trung → Anh → Việt trong worker. Nếu nhập OpenRouter key, gọi trực tiếp OpenRouter trước và dùng model cục bộ khi lỗi.
5. Xem video với phụ đề đúng thời gian, tải SRT/VTT; bấm **Xuất MP4 có phụ đề** để FFmpeg WebAssembly nhúng chữ tiếng Việt vào video.

**Không nhập key thì lời thoại và video không gửi tới API dịch.** Key tùy chọn chỉ ở RAM, không ghi localStorage hay đưa vào bản build. Khi dùng OpenRouter, chỉ lời thoại được gửi; video vẫn trên máy.

- Hỗ trợ Chrome/Edge mới trên máy tính, HTTPS hoặc localhost. Không mở `index.html` bằng `file://`.
- Tối đa 250 MB / 20 phút để hạn chế RAM; nên thử clip ngắn trước. Dựng MP4 trên WebAssembly chậm hơn FFmpeg native.
- Lần đầu cần mạng để tải vài trăm MB model từ Hugging Face. Transformers.js cache model; service worker cache giao diện/WASM. Sau khi tải đủ có thể dùng offline, trừ OpenRouter/URL video. Cache có thể bị trình duyệt xóa hoặc không đủ dung lượng.
- Link **trang** Facebook/TikTok/YouTube không phải URL video. Trình duyệt không chạy yt-dlp và không vượt CORS; hãy tải video về máy rồi chọn tệp. Không có proxy/backend ẩn.
- Bản browser dùng model OPUS-MT (Trung → Anh → Việt), thay cho LibreTranslate/Python. Chất lượng dịch hai bước có thể kém tự nhiên hơn OpenRouter.
- Có SRT sẵn: chọn SRT để bỏ qua Whisper. SRT tiếng Việt: chọn ngôn ngữ **Tiếng Việt (không dịch)**.

## Chạy và build

Cần Node **22.12+** và npm **chỉ khi phát triển/build**:

```sh
npm ci
npm run dev
```

Mở URL Vite in ra (thường `http://127.0.0.1:5173`). Đây là máy chủ **phục vụ tệp tĩnh cho development**, không có API xử lý video.

```sh
npm run check           # kiểm tra timeline + build
npm run preview         # xem bản build
```

`web-dist/` là toàn bộ website cần deploy. Không upload `vendor/`, `dist/` desktop, `node_modules/`, video hay Python. `base: './'` cho phép chạy cả ở domain gốc và `/ten-repo/`. WASM single-thread chạy được trên GitHub Pages **không cần COOP/COEP hay SharedArrayBuffer**.

## Deploy GitHub Pages bằng gh-pages (nhanh nhất)

Repo hiện chưa cấu hình remote. Bạn có thể publish trực tiếp bản web sang một repo GitHub mới, kể cả khi repo desktop cũ đang track các file rất lớn:

1. Tạo repository trống, ví dụ `vietsub-studio`, trên GitHub.
2. Đăng nhập Git bằng Git Credential Manager hoặc `gh auth login`; bảo đảm `git config user.name` và `git config user.email` đã được đặt.
3. Chạy (thay `TEN_CUA_BAN`):

   ```sh
   npm ci
   npm run deploy -- --repo https://github.com/TEN_CUA_BAN/vietsub-studio.git
   ```

   `predeploy` tự build. `gh-pages` chỉ push nội dung **web-dist/** lên nhánh **gh-pages** của repo đích, không push lịch sử desktop/native tools.

4. Trong repo GitHub: **Settings → Pages → Build and deployment**:
   - Source: **Deploy from a branch**.
   - Branch: **gh-pages**, folder: **/(root)** → **Save**.
5. Chờ Pages deploy thành công trong tab **Actions**, rồi mở:

   ```text
   https://TEN_CUA_BAN.github.io/vietsub-studio/
   ```

6. Mỗi lần cập nhật: chạy lại lệnh `npm run deploy -- --repo ...`.

Nếu đã có remote `origin` trỏ đúng repo, chỉ cần `npm run deploy`. Không đặt API key vào GitHub Secrets hay mã nguồn để build: người dùng nhập key tùy chọn trên giao diện.

## Tự động deploy bằng GitHub Actions

Đã có `.github/workflows/pages.yml`: push `main`/`master` → kiểm tra → build → deploy Pages. Nếu dùng cách này, đặt **Settings → Pages → Source = GitHub Actions**, thay cho cách nhánh gh-pages ở trên.

Đưa các nguồn web sau lên repo: `src/`, `public/fonts/`, `scripts/`, `tests/`, `.github/`, `.gitignore`, `index.html`, `package.json`, `package-lock.json`, `vite.config.js`, `playwright.config.js`, `README.md`.

**Repo desktop cũ đã track file lớn:** `.gitignore` không bỏ tracking hay xóa lịch sử. Để giữ repo cũ như bạn yêu cầu, dùng cách `gh-pages --repo` ở trên; hoặc tạo repo nguồn web sạch từ danh sách này. Không push nguyên lịch sử chứa bộ cài/model hàng trăm MB lên GitHub. Workflow chỉ xuất bản `web-dist/`.

## Sửa lỗi phụ đề bị giữ ở câu đầu

- Mỗi kết quả xóa toàn bộ cue cũ và tạo `VTTCue` mới, kể cả xử lý lại cùng video.
- Mốc thời gian luôn là số giây; loại cue không hợp lệ và giới hạn end trước câu kế tiếp.
- Cue thiếu thời điểm kết thúc được giới hạn thay vì kéo dài toàn video.
- Bật/tắt phụ đề hoặc chuyển MP4 nhúng phụ đề không để lại track cũ.
- Có test thật trong Chromium cho tua tiến/lùi, khoảng trống giữa câu, bật/tắt, job mới và xuất MP4.

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Test model thật (tải model, có thể chạy vài phút) trên PowerShell:

```powershell
$env:RUN_MODEL_TEST='1'
npm run test:browser -- --grep 'real browser'
```

## Cấu trúc

- `src/app.js`: UI, luồng client, hủy tác vụ, quản lý Blob URL.
- `src/inference.worker.js`: Whisper và OPUS-MT trên WASM.
- `src/media.js`: FFmpeg single-thread, trích âm thanh / xuất MP4.
- `src/subtitles.js`: timeline, SRT/VTT/ASS, quản lý TextTrack.
- `public/fonts/`: Noto Sans có ký tự tiếng Việt, giấy phép OFL đi kèm.
- `scripts/prepare-assets.mjs`: copy runtime từ dependency npm vào web build.
- `legacy/`: nguồn Node/Electron cũ để tham khảo, không nằm trong website.

Tham khảo: [GitHub Pages](https://docs.github.com/en/pages), [gh-pages](https://github.com/tschaub/gh-pages), [Vite static deploy](https://vite.dev/guide/static-deploy.html#github-pages). Bài Medium bạn gửi hiện trả HTTP 403 khi truy cập từ môi trường này; cấu hình dùng quy trình gh-pages/GitHub Pages chính thức.
