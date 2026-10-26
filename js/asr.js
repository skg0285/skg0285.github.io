// 음성 인식 작업자(asr-worker.js)를 다루는 도우미
import { asrModel } from "./config.js";

let worker = null;
let seq = 0;
const pending = new Map();
let progressHandler = null;
const fileProgress = {};

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./asr-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") {
        fileProgress[m.file] = [m.loaded, m.total];
        const vals = Object.values(fileProgress);
        const loaded = vals.reduce((a, v) => a + v[0], 0);
        const total = vals.reduce((a, v) => a + v[1], 0);
        progressHandler?.(total ? Math.round((loaded / total) * 100) : 0);
        return;
      }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.type === "error" ? p.reject(new Error(m.message)) : p.resolve(m);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "음성 인식 오류"));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function call(msg, transfer) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, model: asrModel, ...msg }, transfer || []);
  });
}

// AI 모델 준비 (처음에는 내려받기). onProgress(0~100)
export function prepareASR(onProgress) {
  progressHandler = onProgress;
  return call({ type: "load" });
}

// 16kHz Float32Array → 인식된 영어 문장
export async function transcribe(pcm16k) {
  const copy = new Float32Array(pcm16k);
  const res = await call({ type: "transcribe", audio: copy }, [copy.buffer]);
  return res.text;
}
