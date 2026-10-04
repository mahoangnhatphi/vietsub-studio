import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
// GitHub Pages cannot set COOP/COEP. Both inference and FFmpeg use one thread.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

self.onmessage = async ({ data }) => {
  const { id, task, payload } = data;
  env.backends.onnx.wasm.wasmPaths = payload.runtimeURL;
  const progress = (message, fraction) => self.postMessage({ id, type: 'progress', message, fraction });
  const download = (event) => {
    if (event.status === 'progress') progress(`Tải model ${event.name}: ${event.file} — ${Math.round(event.progress || 0)}%`);
    else if (event.status === 'initiate') progress(`Chuẩn bị model ${event.name}…`);
  };
  let model;
  try {
    let result;
    if (task === 'transcribe') {
      const name = payload.model === 'base' ? 'Xenova/whisper-base' : 'Xenova/whisper-tiny';
      model = await pipeline('automatic-speech-recognition', name, { device: 'wasm', dtype: 'q8', progress_callback: download });
      progress('Whisper đang nhận diện lời thoại trên máy…');
      const output = await model(payload.audio, {
        language: { zh: 'chinese', en: 'english', vi: 'vietnamese' }[payload.language],
        task: 'transcribe', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5,
        chunk_callback: () => progress('Whisper đang xử lý các đoạn âm thanh…'),
      });
      result = output.chunks || [];
    } else if (task === 'translate') {
      let texts = payload.segments.map((s) => s.text);
      const models = payload.language === 'zh' ? ['Xenova/opus-mt-zh-en', 'Xenova/opus-mt-en-vi'] : ['Xenova/opus-mt-en-vi'];
      for (let stage = 0; stage < models.length; stage++) {
        model = await pipeline('translation', models[stage], { device: 'wasm', dtype: 'q8', progress_callback: download });
        const translated = [];
        for (let i = 0; i < texts.length; i++) {
          const output = await model(texts[i], { max_new_tokens: 256, num_beams: 2 });
          const text = output[0]?.translation_text?.trim();
          if (!text) throw new Error(`Model trả về dòng dịch rỗng (${i + 1}).`);
          translated.push(text);
          progress(`Dịch ${stage + 1}/${models.length}: ${i + 1}/${texts.length} câu`, (stage + (i + 1) / texts.length) / models.length);
        }
        texts = translated;
        await model.dispose();
        model = null;
      }
      result = payload.segments.map((s, i) => ({ ...s, text: texts[i] }));
    } else throw new Error('Tác vụ không hợp lệ.');
    if (model) { await model.dispose(); model = null; }
    self.postMessage({ id, type: 'result', result });
  } catch (error) {
    self.postMessage({ id, type: 'error', message: error.message || String(error) });
  } finally { if (model) await model.dispose(); }
};
