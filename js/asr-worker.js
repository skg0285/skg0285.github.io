// 학생 태블릿 안에서 영어 음성을 글자로 바꾸는 작업자 (Whisper, 무료·오프라인 동작)
// 처음 한 번 AI 모델(약 40MB)을 내려받고, 이후에는 기기에 저장된 것을 씁니다.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriber = null;
let loading = null;

function load(model) {
  if (!loading) {
    loading = pipeline("automatic-speech-recognition", model, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (p) => {
        if (p.status === "progress" && p.total) {
          self.postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: p.total });
        }
      },
    }).then((t) => { transcriber = t; return t; })
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}

self.onmessage = async (e) => {
  const { id, type, model, audio } = e.data;
  try {
    if (type === "load") {
      await load(model);
      self.postMessage({ id, type: "ready" });
    } else if (type === "transcribe") {
      const t = await load(model);
      const out = await t(audio);
      self.postMessage({ id, type: "result", text: (out.text || "").trim() });
    }
  } catch (err) {
    self.postMessage({ id, type: "error", message: String(err && err.message || err) });
  }
};
