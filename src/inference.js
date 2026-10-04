export class Inference {
  constructor() {
    this.worker = new Worker(new URL('./inference.worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.sequence = 0;
    this.worker.onmessage = ({ data }) => {
      const job = this.pending.get(data.id);
      if (!job) return;
      if (data.type === 'progress') job.progress(data.message, data.fraction);
      else {
        this.pending.delete(data.id);
        if (data.type === 'result') job.resolve(data.result);
        else job.reject(new Error(data.message));
      }
    };
    this.worker.onerror = (event) => {
      for (const job of this.pending.values()) job.reject(new Error(event.message || 'Worker AI bị dừng. Thử video ngắn hơn.'));
      this.pending.clear();
    };
  }
  run(task, payload, progress, transfer = []) {
    const id = ++this.sequence;
    const runtimeURL = new URL(`${import.meta.env.BASE_URL}runtime/onnx/`, document.baseURI).href;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      this.worker.postMessage({ id, task, payload: { ...payload, runtimeURL } }, transfer);
    });
  }
  dispose() {
    this.worker.terminate();
    for (const job of this.pending.values()) job.reject(new DOMException('Đã hủy', 'AbortError'));
    this.pending.clear();
  }
}
