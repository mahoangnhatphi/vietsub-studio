import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [from, to] of [
  ['node_modules/@ffmpeg/core/dist/esm', 'public/runtime/ffmpeg'],
  ['node_modules/onnxruntime-web/dist', 'public/runtime/onnx'],
]) {
  await rm(path.join(root, to), { recursive: true, force: true });
  await mkdir(path.join(root, to), { recursive: true });
  await cp(path.join(root, from), path.join(root, to), {
    recursive: true,
    filter: (source) => !path.extname(source) || /(?:ort-wasm-simd-threaded(?:\.jsep)?\.(?:wasm|mjs)|ffmpeg-core\.(?:js|wasm))$/.test(source),
  });
}
await writeFile(path.join(root, 'public/.nojekyll'), '');
console.log('WebAssembly assets ready (single thread; no COOP/COEP headers needed).');
