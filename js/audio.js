// 오디오 도구: 원음 구간 재생, 16kHz WAV 녹음, 무음 기준 문장 자동 나누기

let ctx = null;
export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export async function decodeAudio(arrayBuffer) {
  const c = audioCtx();
  return await new Promise((resolve, reject) =>
    c.decodeAudioData(arrayBuffer.slice(0), resolve, reject)
  );
}

// ---------- 재생 ----------
// <audio> 요소로 원음의 start~end(초) 구간만 재생합니다.
export class SegmentPlayer {
  constructor(url) {
    this.el = new Audio();
    this.el.preload = "auto";
    this.el.src = url;
    this.ready = new Promise((resolve, reject) => {
      if (this.el.readyState >= 1) return resolve();
      this.el.addEventListener("loadedmetadata", () => resolve(), { once: true });
      this.el.addEventListener("error", () => reject(new Error("오디오를 불러오지 못했습니다.")), { once: true });
    });
    this.token = 0;
  }

  get duration() { return this.el.duration || 0; }

  async play(start, end, rate = 1) {
    const token = ++this.token;
    this.el.pause();
    await this.ready;
    this.el.playbackRate = rate;
    this.el.currentTime = Math.max(0, start);
    await this.el.play();
    return new Promise((resolve) => {
      const tick = () => {
        if (token !== this.token) return resolve(false);
        if (this.el.currentTime >= end || this.el.ended) {
          this.el.pause();
          return resolve(true);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  stop() {
    this.token++;
    this.el.pause();
  }
}

// ---------- 녹음 ----------
// 같은 마이크 소리를 두 가지로 받습니다:
//  - 16kHz PCM: 기기 안 AI 음성 인식용
//  - 압축 파일(MediaRecorder): 선생님이 들을 녹음 저장용 (작은 용량)
const MIME_CHOICES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];

export class Recorder {
  constructor() {
    this.stream = null;
    this.chunks = [];
    this.node = null;
    this.input = null;
    this.media = null;
    this.mediaParts = [];
  }

  async open() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  }

  async start() {
    const c = audioCtx(); // 탭한 순간에 오디오를 깨워야 iPad에서 동작합니다
    await this.open();
    this.chunks = [];
    this.input = c.createMediaStreamSource(this.stream);
    this.node = c.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    const mute = c.createGain();
    mute.gain.value = 0; // 내 목소리가 스피커로 다시 나오지 않도록
    this.input.connect(this.node);
    this.node.connect(mute);
    mute.connect(c.destination);

    this.mediaParts = [];
    this.media = null;
    if (window.MediaRecorder) {
      const mimeType = MIME_CHOICES.find((m) => MediaRecorder.isTypeSupported?.(m));
      try {
        this.media = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
        this.media.ondataavailable = (e) => { if (e.data.size) this.mediaParts.push(e.data); };
        this.media.start();
      } catch (_) { this.media = null; }
    }
  }

  // 녹음을 끝내고 { pcm16k, audio: Blob, seconds, voiced } 반환
  async stop() {
    const c = audioCtx();
    if (this.node) {
      this.node.disconnect();
      this.input.disconnect();
      this.node.onaudioprocess = null;
      this.node = null;
    }
    let audio = null;
    if (this.media && this.media.state !== "inactive") {
      const media = this.media;
      await new Promise((resolve) => { media.onstop = resolve; media.stop(); });
      if (this.mediaParts.length) audio = new Blob(this.mediaParts, { type: media.mimeType || this.mediaParts[0].type });
    }
    const total = this.chunks.reduce((n, a) => n + a.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const a of this.chunks) { all.set(a, off); off += a.length; }
    this.chunks = [];
    const pcm16k = downsample(all, c.sampleRate, 16000);
    // 압축 녹음이 안 되는 기기는 8kHz WAV로 저장
    if (!audio || audio.size < 200) audio = encodeWav(downsample(pcm16k, 16000, 8000), 8000);
    return { pcm16k, audio, seconds: pcm16k.length / 16000, voiced: voicedSpan(pcm16k, 16000) };
  }

  close() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

// 실제로 말한 구간의 길이(초). 0이면 목소리가 거의 없음
export function voicedSpan(pcm, rate) {
  const frame = Math.round(rate * 0.02);
  const n = Math.floor(pcm.length / frame);
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) s += pcm[j] * pcm[j];
    if (Math.sqrt(s / frame) > 0.015) { if (first < 0) first = i; last = i; }
  }
  return first < 0 ? 0 : ((last - first + 1) * frame) / rate;
}

export function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const len = Math.floor(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = b > a ? sum / (b - a) : 0;
  }
  return out;
}

export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ---------- 문장 자동 나누기 ----------
// 소리 크기(RMS)로 무음 구간을 찾고, 가장 긴 무음 (count-1)개를 문장 경계로 사용합니다.
export function autoSegment(buffer, count) {
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const frame = Math.round(rate * 0.02); // 20ms
  const n = Math.floor(data.length / frame);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) s += data[j] * data[j];
    rms[i] = Math.sqrt(s / frame);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const loud = sorted[Math.floor(n * 0.9)] || 0;
  const floor = sorted[Math.floor(n * 0.1)] || 0;
  const threshold = Math.max(floor * 2, loud * 0.08, 0.003);
  const voiced = Array.from(rms, (v) => v > threshold);

  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  const t = (i) => (i * frame) / rate;
  if (first < 0 || count <= 0) return evenSegments(buffer.duration, count);

  // 말소리 사이의 무음 구간들
  const gaps = [];
  let i = first;
  while (i <= last) {
    if (!voiced[i]) {
      const s = i;
      while (i <= last && !voiced[i]) i++;
      if (i - s >= 8) gaps.push({ s, e: i, len: i - s }); // 160ms 이상
    } else i++;
  }
  if (gaps.length < count - 1) return evenSegments(buffer.duration, count, t(first), t(last + 1));

  const cuts = gaps.sort((a, b) => b.len - a.len).slice(0, count - 1).sort((a, b) => a.s - b.s);
  const segs = [];
  let start = t(first);
  for (const g of cuts) {
    segs.push({ start: start, end: t(g.s) });
    start = t(g.e);
  }
  segs.push({ start, end: t(last + 1) });
  // 앞뒤 여유
  return segs.map((s) => ({
    start: round2(Math.max(0, s.start - 0.15)),
    end: round2(Math.min(buffer.duration, s.end + 0.25)),
  }));
}

function evenSegments(duration, count, from = 0, to = duration) {
  const step = (to - from) / Math.max(1, count);
  return Array.from({ length: count }, (_, k) => ({
    start: round2(from + k * step),
    end: round2(from + (k + 1) * step),
  }));
}

function round2(x) { return Math.round(x * 100) / 100; }

// 대본을 문장 단위로 나눕니다 (한 줄에 한 문장으로 편집 가능)
export function splitSentences(script) {
  const lines = script.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  return (script.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [])
    .map((s) => s.trim())
    .filter(Boolean);
}
