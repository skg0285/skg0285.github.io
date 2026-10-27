import {
  initializeApp, getAuth, GoogleAuthProvider, OAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut,
  getFirestore, doc, getDoc, setDoc, deleteDoc, collection, query, where, getDocs, serverTimestamp,
  writeBatch, Bytes,
} from "./firebase-sdk.js";
import { firebaseConfig, loginOptions, defaultClasses, allowedDomains, passScore } from "./config.js";
import { SegmentPlayer, Recorder, decodeAudio, autoSegment, splitSentences } from "./audio.js";
import { prepareASR, transcribe } from "./asr.js";
import { scoreSentence } from "./score.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $app = document.getElementById("app");
const state = { user: null, isTeacher: false, testMode: false, profile: null, classes: defaultClasses };

// 선생님이 학생 화면으로 직접 연습해 보는 "테스트 모드" (기록은 '테스트' 반으로 저장)
const TEST_CLASS = "테스트";
const TEST_PROFILE = { classId: TEST_CLASS, number: 0, name: "선생님 테스트" };
const actingAsStudent = () => !state.isTeacher || state.testMode;

// ---------- 공통 도구 ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const scoreClass = (v) => (v == null ? "none" : v >= 80 ? "good" : v >= 60 ? "ok" : "bad");

function toast(msg, ms = 3000) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

function errMsg(e) {
  console.error(e);
  if (e?.code === "permission-denied") return "권한이 없습니다.";
  return e?.message || "오류가 발생했습니다.";
}

let cleanup = null; // 화면을 떠날 때 정리할 작업
function render(html) {
  if (cleanup) { cleanup(); cleanup = null; }
  $app.innerHTML = html;
  window.scrollTo(0, 0);
}

function header(sub = "") {
  if (state.testMode) {
    return `<header class="top">
      <a href="#/" class="brand">🎧 따라 말하기</a>
      <span class="who test-badge">🧪 학생 화면 테스트 중</span>
      <button class="btn sm" id="endTest">선생님 화면으로</button>
    </header>${sub}`;
  }
  const who = state.isTeacher ? "선생님" : state.profile ? `${esc(state.profile.classId)} ${state.profile.number}번 ${esc(state.profile.name)}` : "";
  return `<header class="top">
    <a href="#/" class="brand">🎧 따라 말하기</a>
    <span class="who">${who}</span>
    <button class="link" id="logout">로그아웃</button>
  </header>${sub}`;
}

function bindHeader() {
  document.getElementById("logout")?.addEventListener("click", () => signOut(auth));
  document.getElementById("endTest")?.addEventListener("click", () => setTestMode(false));
}

async function setTestMode(on, stayHere = false) {
  try {
    if (on) {
      const data = { ...TEST_PROFILE, email: state.user.email || "", updatedAt: serverTimestamp() };
      await setDoc(doc(db, "users", state.user.uid), data);
      state.profile = data;
    } else state.profile = null;
    state.testMode = on;
    try { on ? sessionStorage.setItem("test-mode", "1") : sessionStorage.removeItem("test-mode"); } catch (_) {}
    if (stayHere || location.hash === "#/") route(); else location.hash = "#/";
  } catch (e) { toast(errMsg(e)); }
}

async function loadSettings() {
  try {
    const s = await getDoc(doc(db, "meta", "settings"));
    if (s.exists() && Array.isArray(s.data().classes) && s.data().classes.length) state.classes = s.data().classes;
  } catch (_) {}
}

// ---------- 오디오 저장 (무료 요금제: Firestore 문서에 나눠 저장) ----------
const CHUNK = 900 * 1024; // 문서 1개 최대 1MB
const MAX_LESSON_AUDIO = 15 * 1024 * 1024;

// 오디오 파일 1개를 저장하고 위치 정보 { v, n, mime } 를 돌려줍니다
async function saveAudio(lessonId, file, tag = "") {
  const buf = new Uint8Array(await file.arrayBuffer());
  const v = `${Date.now()}${tag}`;
  const n = Math.ceil(buf.length / CHUNK);
  for (let i = 0; i < n; i++) {
    await setDoc(doc(db, "lessonAudio", `${lessonId}_${v}_${i}`), {
      lessonId, i, data: Bytes.fromUint8Array(buf.slice(i * CHUNK, (i + 1) * CHUNK)),
    });
  }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const types = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg" };
  return { v, n, mime: file.type.startsWith("audio/") ? file.type : types[ext] || "audio/mpeg" };
}

function deleteAudio(lessonId, ref) {
  if (!ref?.n) return;
  for (let i = 0; i < ref.n; i++) deleteDoc(doc(db, "lessonAudio", `${lessonId}_${ref.v}_${i}`)).catch(() => {});
}

// 수업의 모든 원음 위치 (긴 파일 1개 또는 문장별 파일)
function lessonAudioRefs(lesson) {
  if (lesson.mode === "files") return (lesson.sentences || []).map((x) => x.audio).filter(Boolean);
  return lesson.audioChunks ? [{ v: lesson.audioVersion, n: lesson.audioChunks, mime: lesson.audioMime, demo: lesson.demo }] : [];
}

// 원음을 불러와 재생 주소(blob URL)를 돌려줍니다. 한 번 받은 원음은 기기에 저장해 다시 받지 않습니다.
async function audioUrl(lessonId, ref) {
  const key = `/__lesson-audio/${lessonId}/${ref.v}`;
  let cache = null;
  try {
    cache = await caches.open("lesson-audio");
    const hit = await cache.match(key);
    if (hit) return URL.createObjectURL(new Blob([await hit.arrayBuffer()], { type: ref.mime }));
  } catch (_) { cache = null; }
  const snaps = await Promise.all(Array.from({ length: ref.n }, (_, i) =>
    getDoc(doc(db, "lessonAudio", `${lessonId}_${ref.v}_${i}`))));
  if (snaps.some((x) => !x.exists())) throw new Error("원음 파일이 없습니다. 선생님께 알려 주세요.");
  const blob = new Blob(snaps.map((x) => x.data().data.toUint8Array()), { type: ref.mime });
  try { await cache?.put(key, new Response(blob)); } catch (_) {}
  return URL.createObjectURL(blob);
}

async function recordingUrl(attemptId) {
  const r = await getDoc(doc(db, "recordings", attemptId));
  if (!r.exists()) return null;
  const d = r.data();
  return URL.createObjectURL(new Blob([d.audio.toUint8Array()], { type: d.mime }));
}

function speedText(speed) {
  if (!speed) return "";
  if (speed > 1.35) return `원음보다 ${speed.toFixed(1)}배 느려요`;
  if (speed < 0.75) return `원음보다 빨라요 (${speed.toFixed(1)}배)`;
  return "원음과 비슷한 속도예요 👍";
}

// 학생 정보(반·번호·이름)가 바뀌면 그 학생의 점수 기록에도 똑같이 반영
async function syncAttemptProfile(uid, profile) {
  const at = await getDocs(query(collection(db, "attempts"), where("uid", "==", uid)));
  let batch = writeBatch(db), n = 0;
  for (const d of at.docs) {
    batch.set(doc(db, "attempts", d.id), { classId: profile.classId, name: profile.name, number: profile.number }, { merge: true });
    if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
  }
  await batch.commit();
}

// ---------- 로그인 ----------
function viewLogin() {
  const inTeams = /Teams/i.test(navigator.userAgent);
  render(`<main class="center">
    <div class="card login">
      <h1>🎧 영어 따라 말하기</h1>
      <p class="muted">문장을 듣고, 따라 말하고, 발음 점수를 받아 보세요.</p>
      ${loginOptions.microsoft ? `<button class="btn big ms" id="ms">Microsoft 계정으로 로그인</button>` : ""}
      ${loginOptions.google ? `<button class="btn big google" id="google">Google 계정으로 로그인</button>` : ""}
      ${inTeams ? `<p class="warn">Teams 안에서는 로그인이 안 될 수 있어요. 오른쪽 위 메뉴에서 <b>브라우저에서 열기</b>를 눌러 주세요.</p>` : ""}
      <p class="muted small">처음에 마이크 사용 허용을 눌러 주세요.</p>
    </div>
  </main>`);
  const go = async (provider) => {
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        return signInWithRedirect(auth, provider);
      }
      if (e.code === "auth/account-exists-with-different-credential") {
        return toast("이 이메일은 다른 방법으로 이미 가입되어 있어요. 처음에 사용한 로그인 버튼을 눌러 주세요.", 6000);
      }
      if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
      toast("로그인 실패: " + (e.code || e.message), 6000);
    }
  };
  document.getElementById("ms")?.addEventListener("click", () => {
    const p = new OAuthProvider("microsoft.com");
    p.setCustomParameters({ prompt: "select_account", tenant: loginOptions.microsoftTenant || "organizations" });
    go(p);
  });
  document.getElementById("google")?.addEventListener("click", () => {
    const p = new GoogleAuthProvider();
    // 학교 계정이 하나뿐이면 Google 로그인 창에 그 학교 계정만 보이도록 안내
    p.setCustomParameters(allowedDomains.length === 1 ? { prompt: "select_account", hd: allowedDomains[0] } : { prompt: "select_account" });
    go(p);
  });
}

// ---------- 학생 정보 등록 ----------
function viewProfile() {
  const p = state.profile || {};
  render(`${header()}<main class="narrow">
    <div class="card">
      <h2>학생 정보 등록</h2>
      <p class="muted">선생님이 결과를 확인할 수 있도록 정확히 입력해 주세요.</p>
      <label>반<select id="cls">${state.classes.map((c) => `<option ${c === p.classId ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>번호<input id="num" type="number" inputmode="numeric" min="1" max="99" value="${esc(p.number ?? "")}"></label>
      <label>이름<input id="name" maxlength="30" value="${esc(p.name ?? "")}"></label>
      <button class="btn big primary" id="save">저장</button>
    </div>
  </main>`);
  bindHeader();
  document.getElementById("save").addEventListener("click", async () => {
    const classId = document.getElementById("cls").value;
    const number = parseInt(document.getElementById("num").value, 10);
    const name = document.getElementById("name").value.trim();
    if (!name || !(number >= 1 && number <= 99)) return toast("번호와 이름을 입력하세요.");
    try {
      const data = { classId, number, name, email: state.user.email || "", updatedAt: serverTimestamp() };
      await setDoc(doc(db, "users", state.user.uid), data);
      state.profile = data;
      await syncAttemptProfile(state.user.uid, data).catch(() => {});
      location.hash = "#/";
      route();
    } catch (e) { toast(errMsg(e)); }
  });
}

// ---------- 학생: 수업 목록 ----------
async function viewStudentHome() {
  render(`${header()}<main><h2>내 수업</h2>
    ${state.testMode ? `<p class="muted small">학생과 똑같은 화면이에요. 비공개 수업도 보이고, 기록은 [학생 결과]의 '${TEST_CLASS}' 반에 저장돼요.</p>` : ""}
    <div id="list" class="muted">불러오는 중…</div>
    ${state.testMode ? "" : `<p class="right"><button class="link" id="edit">학생 정보 수정</button></p>`}</main>`);
  bindHeader();
  document.getElementById("edit")?.addEventListener("click", () => viewProfile());
  try {
    const [ls, at] = await Promise.all([
      state.testMode ? getDocs(collection(db, "lessons"))
        : getDocs(query(collection(db, "lessons"), where("classes", "array-contains", state.profile.classId))),
      getDocs(query(collection(db, "attempts"), where("uid", "==", state.user.uid))),
    ]);
    const done = {};
    at.forEach((d) => {
      const a = d.data();
      (done[a.lessonId] ||= []).push(a.pron);
    });
    const lessons = ls.docs.map((d) => ({ id: d.id, ...d.data() })).filter((l) => l.published || state.testMode)
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    const el = document.getElementById("list");
    if (!lessons.length) { el.textContent = "아직 올라온 수업이 없어요."; return; }
    el.className = "lesson-list";
    el.innerHTML = lessons.map((l) => {
      const total = (l.sentences || []).length;
      const scores = done[l.id] || [];
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      return `<a class="card lesson" href="#/practice/${l.id}">
        <div><b>${esc(l.title)}</b>${l.published ? "" : ` <span class="badge">비공개</span>`}<div class="muted small">${scores.length} / ${total} 문장 완료</div></div>
        <span class="score ${scoreClass(avg)}">${avg == null ? "시작" : avg + "%"}</span>
      </a>`;
    }).join("");
  } catch (e) { document.getElementById("list").textContent = errMsg(e); }
}

// ---------- 학생: 연습 ----------
async function viewPractice(lessonId) {
  render(`${header()}<main class="muted">불러오는 중…</main>`);
  bindHeader();
  let lesson, attempts = {};
  try {
    const snap = await getDoc(doc(db, "lessons", lessonId));
    if (!snap.exists()) throw new Error("수업을 찾을 수 없습니다.");
    lesson = snap.data();
    if (actingAsStudent()) {
      const at = await getDocs(query(collection(db, "attempts"), where("uid", "==", state.user.uid), where("lessonId", "==", lessonId)));
      at.forEach((d) => { attempts[d.data().index] = d.data(); });
    }
  } catch (e) { return render(`${header()}<main>${esc(errMsg(e))}</main>`); }

  const sentences = lesson.sentences || [];
  // 긴 파일 1개: 플레이어 하나를 구간별로 재생 / 문장별 파일: 문장마다 플레이어
  const filesMode = lesson.mode === "files";
  const players = new Map();
  const playerFor = (i) => {
    const k = filesMode ? i : 0;
    if (!players.has(k)) {
      const ref = filesMode ? sentences[i].audio : lessonAudioRefs(lesson)[0];
      players.set(k, audioUrl(lessonId, ref).then((u) => new SegmentPlayer(u)));
    }
    return players.get(k);
  };
  const stopAll = () => players.forEach((p) => p.then((x) => x.stop()).catch(() => {}));
  try { await playerFor(0); }
  catch (e) { return render(`${header()}<main>${esc(errMsg(e))}</main>`); }
  if (filesMode) sentences.forEach((_, i) => playerFor(i).catch(() => {})); // 나머지 문장도 미리 받아 두기
  const recorder = new Recorder();
  const student = actingAsStudent();
  // 통과: 저장한 완성도(최고 점수)가 passScore 초과. 통과해야 다음 문장으로 갈 수 있음 (선생님 미리보기는 제한 없음)
  const passed = (i) => !student || (attempts[i]?.best ?? 0) > passScore;
  const firstLocked = () => { const k = sentences.findIndex((_, i) => !passed(i)); return k < 0 ? sentences.length : k; };
  const reachable = (i) => i <= firstLocked();
  let idx = Math.min(firstLocked(), sentences.length - 1);
  let rate = 1, recording = null, busy = false, asrReady = false;
  let pending = null;      // 방금 녹음해서 채점했지만 아직 저장하지 않은 것 { result, audio, url }
  let leaveWarned = false; // 저장 안 한 채로 넘어가려 할 때 한 번 알려 줌
  let camStream = null;

  render(`${header()}<main class="practice">
    <div class="row between"><a href="#/" class="link">← 목록</a><b>${esc(lesson.title)}</b><span id="pos"></span></div>
    <div id="dots" class="dots"></div>
    <div class="card sentence-card">
      <div id="sentence" class="sentence"></div>
      <div class="controls four">
        <button class="btn round listen" id="listen">▶<span>듣기</span></button>
        <button class="btn round rec" id="rec">●<span>녹음하기</span></button>
        <button class="btn round redo" id="redo" disabled>↻<span>다시 녹음하기</span></button>
        <button class="btn round save" id="save" disabled>✓<span>녹음 저장하기</span></button>
      </div>
      <div class="row center gap">
        <span class="muted small">속도</span>
        ${[1, 0.8, 0.6].map((r) => `<button class="chip ${r === 1 ? "on" : ""}" data-rate="${r}">${r}x</button>`).join("")}
      </div>
      <div class="row center gap wrap options">
        <span class="small muted">📷 녹음할 때는 카메라로 내 얼굴을 보면서 말해요</span>
        <label class="check small"><input type="checkbox" id="dup"> 녹음할 때 원음도 같이 재생 (이어폰을 꼈을 때만)</label>
      </div>
      <div id="status" class="status"></div>
    </div>
    <div id="result"></div>
    <p id="passHint" class="pass-hint" hidden></p>
    <div class="row between">
      <button class="btn" id="prev">← 이전 문장</button>
      <button class="btn primary" id="next">다음 문장 →</button>
    </div>
  </main>
  <div class="cam" id="cam" hidden><video id="camVideo" playsinline muted autoplay></video><p id="camMsg" hidden></p></div>`);
  bindHeader();

  const $ = (id) => document.getElementById(id);
  const status = (t) => { $("status").textContent = t; };
  const dropPending = () => { if (pending?.url) URL.revokeObjectURL(pending.url); pending = null; };
  cleanup = () => { stopAll(); recorder.close(); stopCamera(); dropPending(); };

  // ---------- 카메라 (내 얼굴 보기, 녹화는 하지 않음) ----------
  // 카메라는 필수: 켜지지 않으면 녹음을 시작하지 않음. 성공하면 true
  async function startCamera() {
    $("camVideo").hidden = false;
    $("camMsg").hidden = true;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 320, height: 240 }, audio: false });
      $("camVideo").srcObject = camStream;
      $("camVideo").play?.().catch(() => {});
      $("cam").hidden = false;
      return true;
    } catch (_) {
      stopCamera();
      return false;
    }
  }
  function stopCamera() {
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
    const v = $("camVideo");
    if (v) v.srcObject = null;
    if ($("cam")) $("cam").hidden = true;
  }

  // ---------- 그리기 ----------
  function drawDots() {
    $("dots").innerHTML = sentences.map((_, i) => {
      const a = attempts[i];
      const locked = !reachable(i);
      return `<button class="dot ${scoreClass(a?.pron)} ${i === idx ? "cur" : ""} ${locked ? "locked" : ""}" data-i="${i}" ${locked ? 'aria-label="잠김"' : ""}>${locked ? "🔒" : i + 1}</button>`;
    }).join("");
  }

  // 다음 문장 버튼과 안내: 이 문장을 통과해야 열림
  function drawGate() {
    const ok = passed(idx);
    const last = idx === sentences.length - 1;
    $("next").classList.toggle("locked", !ok);
    $("next").textContent = (ok ? "" : "🔒 ") + (last ? "목록으로" : "다음 문장 →");
    const hint = $("passHint");
    hint.hidden = ok;
    if (!ok) {
      hint.textContent = pending && pending.result.pron > passScore
        ? `${pending.result.pron}%예요! 녹음 저장하기를 누르면 다음으로 넘어갈 수 있어요.`
        : `완성도 ${passScore + 1}% 이상을 저장해야 다음 문장으로 넘어갈 수 있어요.`;
    }
  }

  function drawSentence(words) {
    const s = sentences[idx];
    if (!words || !words.length) { $("sentence").textContent = s.text; return; }
    $("sentence").innerHTML = words.filter((w) => w.e !== "Insertion").map((w) => {
      const cls = w.e === "Omission" ? "omit" : scoreClass(w.s);
      const tip = w.e === "Omission" ? "빠뜨림" : w.e === "Mispronunciation" ? `발음 ${w.s}점` : `${w.s}점`;
      return `<span class="w ${cls}" title="${tip}">${esc(w.w)}</span>`;
    }).join(" ");
  }

  // a: 결과, saved: 저장된 기록인지
  function drawResult(a, saved) {
    if (!a) { $("result").innerHTML = ""; return; }
    const mine = `<button class="link" id="mine">▶ 내 녹음 듣기</button>`;
    if (!a.recognized) {
      $("result").innerHTML = `<div class="card result"><p>목소리가 잘 들리지 않았어요. <b>다시 녹음하기</b>를 눌러 마이크 가까이에서 말해 보세요.</p>${mine}</div>`;
    } else {
      const saveLine = saved
        ? `<p class="saved-note">✓ 저장됨 · 시도 ${a.tries}회 · 최고 ${a.best}%</p>`
        : `<p class="unsaved-note">아직 저장하지 않았어요. 마음에 들면 <b>녹음 저장하기</b>, 아니면 <b>다시 녹음하기</b>를 누르세요.</p>`;
      $("result").innerHTML = `<div class="card result">
        <div class="score-label">완성도</div>
        <div class="big-score ${scoreClass(a.pron)}">${a.pron}<small>%</small></div>
        <p class="heard">AI가 들은 말: <b>${esc(a.heard || "-")}</b></p>
        <p>${esc(speedText(a.speed))}</p>
        ${saveLine}
        ${mine}
      </div>`;
    }
    $("mine").addEventListener("click", playMine);
  }

  function setButtons() {
    const canRec = asrReady && student && !busy;
    const recBtn = (el, label, icon, isOn) => {
      el.classList.toggle("on", isOn);
      el.innerHTML = isOn ? "■<span>멈춤</span>" : `${icon}<span>${label}</span>`;
    };
    recBtn($("rec"), "녹음하기", "●", recording === "rec");
    recBtn($("redo"), "다시 녹음하기", "↻", recording === "redo");
    $("rec").disabled = recording ? recording !== "rec" : !canRec || !!pending;
    $("redo").disabled = recording ? recording !== "redo" : !canRec || !pending;
    $("save").disabled = !!recording || busy || !pending || !pending.result.recognized;
    $("listen").disabled = false;
  }

  function show() {
    stopAll();
    dropPending();
    leaveWarned = false;
    const a = attempts[idx];
    $("pos").textContent = `${idx + 1} / ${sentences.length}`;
    drawDots();
    drawSentence(a?.words);
    drawResult(a, true);
    status("");
    $("prev").disabled = idx === 0;
    drawGate();
    setButtons();
  }

  async function listen() {
    const s = sentences[idx];
    try {
      const player = await playerFor(idx);
      await player.play(filesMode ? 0 : s.start, filesMode ? Infinity : s.end, rate);
    } catch (e) { toast("재생 오류: " + e.message); }
  }

  // ---------- 녹음 → 바로 채점 ----------
  async function startRecording(which) {
    if (busy) return;
    busy = true; // 카메라가 켜질 때까지 버튼을 잠깐 막음
    setButtons();
    stopAll();
    status("📷 카메라를 켜는 중…");
    const camOk = await startCamera();
    busy = false;
    if (!camOk) {
      setButtons();
      $("status").innerHTML = `<span class="cam-need">📷 카메라를 켜야 녹음할 수 있어요.</span><br><span class="small muted">브라우저에서 카메라를 허용해 주세요. 아이패드: 설정 → Safari → 카메라 → 허용 / 갤럭시탭: 주소창 왼쪽 자물쇠 → 권한 → 카메라 허용</span>`;
      return;
    }
    try {
      dropPending();
      await recorder.start();
      recording = which;
      leaveWarned = false;
      setButtons();
      drawGate();
      status("🔴 녹음 중… 다 말하면 멈춤을 누르세요");
      if ($("dup").checked) listen();
    } catch (e) {
      recording = null;
      stopCamera();
      setButtons();
      status("");
      toast("마이크를 사용할 수 없어요. 브라우저 설정에서 마이크를 허용해 주세요.", 6000);
    }
  }

  async function stopAndScore() {
    recording = null;
    stopAll();
    stopCamera();
    busy = true;
    setButtons();
    const at = idx;
    try {
      const { pcm16k, audio, seconds, voiced } = await recorder.stop();
      if (seconds < 0.5) return status("너무 짧아요. 다시 녹음해 주세요.");
      if (seconds > 30) return status("너무 길어요. 한 문장만 녹음해 주세요.");
      const s = sentences[at];
      const prev = attempts[at] || {};
      const base = {
        uid: state.user.uid, lessonId, index: at,
        classId: state.profile.classId, name: state.profile.name, number: state.profile.number,
      };
      let result;
      if (voiced < 0.3) {
        result = { ...base, recognized: false, pron: 0, words: [], heard: "", speed: 0 };
      } else {
        status("⏳ AI가 듣는 중…");
        const heard = await transcribe(pcm16k);
        const scored = scoreSentence(s.text, heard);
        const modelSpan = Math.max(0.5, s.end - s.start - 0.4);
        result = {
          ...base, recognized: !!heard, pron: scored.pron, words: scored.words, heard: heard.slice(0, 300),
          speed: Math.round((voiced / modelSpan) * 100) / 100,
        };
      }
      result.tries = (prev.tries || 0) + 1;
      result.best = Math.max(prev.best || 0, result.pron);
      if (at !== idx) return;
      pending = { result, audio, url: URL.createObjectURL(audio) };
      drawSentence(result.words);
      drawResult(result, false);
      drawGate();
      status("");
    } catch (e) {
      status("");
      toast("문제가 생겼어요: " + (e.message || e), 5000);
    } finally {
      busy = false;
      setButtons();
    }
  }

  function onRecordButton(which) {
    if (busy) return;
    if (recording === which) return stopAndScore();
    if (!recording) startRecording(which);
  }

  // ---------- 저장 ----------
  async function saveTake() {
    if (!pending || busy) return;
    const { result, audio } = pending;
    const at = result.index;
    busy = true;
    setButtons();
    status("💾 저장 중…");
    try {
      const attemptId = `${state.user.uid}_${lessonId}_${at}`;
      const data = { ...result, updatedAt: serverTimestamp() };
      const bytes = new Uint8Array(await audio.arrayBuffer());
      const batch = writeBatch(db);
      batch.set(doc(db, "attempts", attemptId), data);
      if (bytes.length < CHUNK) {
        batch.set(doc(db, "recordings", attemptId), {
          uid: state.user.uid, lessonId, mime: audio.type || "audio/wav", audio: Bytes.fromUint8Array(bytes),
        });
      }
      await batch.commit();
      attempts[at] = data;
      savedUrls.set(at, pending.url);
      pending = null;
      if (at === idx) { drawDots(); drawResult(data, true); drawGate(); }
      status("");
      toast(data.pron > passScore ? "저장했어요 ✓ 다음 문장으로 넘어갈 수 있어요." : "저장했어요 ✓");
    } catch (e) {
      status("");
      toast(e?.code === "resource-exhausted"
        ? "오늘 무료 저장 한도를 다 썼어요. 내일 다시 해 주세요."
        : "저장하지 못했어요: " + (e.message || e), 5000);
    } finally {
      busy = false;
      setButtons();
    }
  }

  const savedUrls = new Map(); // 이번에 저장한 녹음은 다시 받지 않고 바로 재생
  async function playMine() {
    stopAll();
    let url = pending?.url || savedUrls.get(idx);
    if (!url && attempts[idx]) {
      try { url = await recordingUrl(`${state.user.uid}_${lessonId}_${idx}`); if (url) savedUrls.set(idx, url); } catch (_) {}
    }
    if (url) new Audio(url).play();
    else toast("들을 녹음이 없어요.");
  }

  // 저장하지 않은 녹음이 있으면 한 번 알려 주고, 한 번 더 누르면 이동
  function canLeave() {
    if (recording || busy) return false;
    if (pending && pending.result.recognized && !leaveWarned) {
      leaveWarned = true;
      toast("저장하지 않은 녹음이 있어요. 저장하려면 '녹음 저장하기', 그냥 넘어가려면 한 번 더 누르세요.", 5000);
      return false;
    }
    return true;
  }

  $("listen").addEventListener("click", listen);
  $("rec").addEventListener("click", () => onRecordButton("rec"));
  $("redo").addEventListener("click", () => onRecordButton("redo"));
  $("save").addEventListener("click", saveTake);
  document.querySelectorAll("[data-rate]").forEach((b) => b.addEventListener("click", () => {
    rate = Number(b.dataset.rate);
    document.querySelectorAll("[data-rate]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("dots").addEventListener("click", (e) => {
    const b = e.target.closest(".dot");
    if (!b) return;
    const i = Number(b.dataset.i);
    if (!reachable(i)) return toast(`앞 문장을 완성도 ${passScore + 1}% 이상으로 저장해야 열려요.`);
    if (i !== idx && canLeave()) { idx = i; show(); }
  });
  $("prev").addEventListener("click", () => { if (idx > 0 && canLeave()) { idx--; show(); } });
  $("next").addEventListener("click", () => {
    if (recording || busy) return;
    if (!passed(idx)) {
      const best = attempts[idx]?.best;
      return toast(pending && pending.result.pron > passScore
        ? "녹음 저장하기를 먼저 눌러 주세요. 저장하면 다음으로 넘어갈 수 있어요."
        : `완성도가 ${passScore}%를 넘어야 다음 문장으로 갈 수 있어요.${best != null ? ` (지금 최고 ${best}%)` : ""}`, 4500);
    }
    if (!canLeave()) return;
    if (idx < sentences.length - 1) { idx++; show(); } else location.hash = "#/";
  });
  show();
  if (!student) {
    $("status").innerHTML = `선생님 미리보기에서는 듣기만 돼요. <button class="btn sm" id="goTest">🧪 학생 화면으로 녹음 테스트</button>`;
    $("goTest").addEventListener("click", () => setTestMode(true, true));
  } else {
    const loadASR = () => {
      status("🤖 AI 준비 중… (처음 한 번은 1~2분 걸려요)");
      prepareASR((pct) => status(`🤖 AI 내려받는 중… ${pct}% (처음 한 번만)`))
        .then(() => { asrReady = true; setButtons(); if (!busy && !recording) status(""); })
        .catch(() => {
          $("status").innerHTML = `AI를 불러오지 못했어요. 인터넷 연결을 확인하세요. <button class="link" id="retry">다시 시도</button>`;
          $("retry").addEventListener("click", loadASR);
        });
    };
    loadASR();
  }
}

// ---------- 선생님 ----------
function teacherTabs(active) {
  const tab = (h, t) => `<a href="${h}" class="tab ${active === h ? "on" : ""}">${t}</a>`;
  return `<nav class="tabs">${tab("#/", "학생 결과")}${tab("#/lessons", "수업 자료")}${tab("#/settings", "설정")}${tab("#/test", "🧪 학생 화면 테스트")}</nav>`;
}

async function getAllLessons() {
  const ls = await getDocs(collection(db, "lessons"));
  return ls.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

// 학생 결과
async function viewResults() {
  render(`${header(teacherTabs("#/"))}<main class="wide">
    <div class="row gap wrap">
      <label>수업<select id="lesson"></select></label>
      <label>반<select id="cls">${state.classes.concat(TEST_CLASS).map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
      <button class="btn" id="reload">새로고침</button>
      <button class="btn" id="csv">엑셀(CSV) 저장</button>
      <button class="btn danger" id="clearTest" hidden>테스트 기록 지우기</button>
    </div>
    <div id="table" class="muted">수업을 선택하세요.</div>
  </main>
  <div id="modal" class="modal hidden"></div>`);
  bindHeader();
  const $ = (id) => document.getElementById(id);
  const lessons = await getAllLessons();
  if (!lessons.length) { $("table").textContent = "먼저 [수업 자료] 탭에서 수업을 만드세요."; return; }
  $("lesson").innerHTML = lessons.map((l) => `<option value="${l.id}">${esc(l.title)}</option>`).join("");
  const saved = sessionStorage.getItem("res-sel");
  if (saved) { try { const s = JSON.parse(saved); $("lesson").value = s.l; $("cls").value = s.c; } catch (_) {} }
  if (!$("lesson").value) $("lesson").value = lessons[0].id;
  if (!$("cls").value) $("cls").selectedIndex = 0;

  let rows = [], lesson = null;

  async function load() {
    const lessonId = $("lesson").value, cls = $("cls").value;
    sessionStorage.setItem("res-sel", JSON.stringify({ l: lessonId, c: cls }));
    lesson = lessons.find((l) => l.id === lessonId);
    $("clearTest").hidden = cls !== TEST_CLASS;
    $("table").textContent = "불러오는 중…";
    try {
      const [us, at] = await Promise.all([
        getDocs(query(collection(db, "users"), where("classId", "==", cls))),
        getDocs(query(collection(db, "attempts"), where("lessonId", "==", lessonId), where("classId", "==", cls))),
      ]);
      const byUser = {};
      us.forEach((d) => { byUser[d.id] = { uid: d.id, ...d.data(), at: {} }; });
      at.forEach((d) => {
        const a = d.data();
        byUser[a.uid] ||= { uid: a.uid, name: a.name, number: a.number, classId: a.classId, at: {} };
        byUser[a.uid].at[a.index] = a;
      });
      rows = Object.values(byUser).sort((a, b) => (a.number || 0) - (b.number || 0));
      drawTable();
    } catch (e) { $("table").textContent = errMsg(e); }
  }

  function drawTable() {
    const n = (lesson.sentences || []).length;
    if (!rows.length) { $("table").textContent = "이 반에 등록된 학생이 없습니다."; return; }
    const head = `<tr><th>번호</th><th>이름</th><th>완료</th><th>평균</th>${Array.from({ length: n }, (_, i) => `<th>${i + 1}</th>`).join("")}</tr>`;
    const count = {};
    rows.forEach((r) => { count[r.number] = (count[r.number] || 0) + 1; });
    const dups = rows.filter((r) => count[r.number] > 1).length;
    const body = rows.map((r, ri) => {
      const sc = Object.values(r.at).map((a) => a.pron);
      const avg = sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : null;
      const cells = Array.from({ length: n }, (_, i) => {
        const a = r.at[i];
        return a ? `<td><button class="cell ${scoreClass(a.pron)}" data-r="${ri}" data-i="${i}">${a.pron}</button></td>` : `<td class="empty">-</td>`;
      }).join("");
      const dup = count[r.number] > 1;
      const id = (r.email || "").split("@")[0];
      return `<tr class="${dup ? "dup" : ""}"><td>${esc(r.number)}${dup ? ` <span class="dup-badge">중복</span>` : ""}</td>
        <td class="name"><button class="link student" data-r="${ri}" title="학생 정보 수정">${esc(r.name)} ✎</button>${id ? `<div class="sid">${esc(id)}</div>` : r.email === undefined ? `<div class="sid">초기화됨 · 학생 재입력 대기</div>` : ""}</td><td>${sc.length}/${n}</td><td><b class="${scoreClass(avg)}-t">${avg ?? "-"}</b></td>${cells}</tr>`;
    }).join("");
    $("table").className = "table-wrap";
    $("table").innerHTML = `<p class="muted small">숫자 = 가장 최근 녹음의 발음 점수(%). 칸을 누르면 녹음을 듣고 자세히 볼 수 있어요. 이름을 누르면 학생 정보를 고치거나 초기화할 수 있어요. 이름 아래 숫자는 학생 계정 아이디예요.</p>
      ${dups ? `<p class="dup-note">⚠ 번호가 겹치는 학생이 ${dups}명 있어요. 계정 아이디를 보고 이름을 눌러 고쳐 주세요.</p>` : ""}
      <table>${head}${body}</table>`;
  }

  // 화면 안에서 한 번 더 확인 (실수로 지우지 않도록)
  function askConfirm(box, message, yesLabel, onYes) {
    box.innerHTML = `<div class="dup-note">${message}
      <div class="row gap wrap" style="margin-top:8px"><button class="btn danger" data-yes>${yesLabel}</button><button class="btn" data-no>취소</button></div></div>`;
    box.querySelector("[data-no]").addEventListener("click", () => { box.innerHTML = ""; });
    box.querySelector("[data-yes]").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try { await onYes(); } catch (err) { toast(errMsg(err)); e.target.disabled = false; }
    });
  }

  // 점수와 녹음을 함께 지움 → 학생은 그 문장을 다시 해야 다음으로 넘어감
  async function deleteAttempts(ids) {
    let batch = writeBatch(db), n = 0;
    for (const id of ids) {
      batch.delete(doc(db, "attempts", id));
      batch.delete(doc(db, "recordings", id));
      if (++n % 200 === 0) { await batch.commit(); batch = writeBatch(db); }
    }
    await batch.commit();
  }

  function closeModal() { const m = $("modal"); m.classList.add("hidden"); m.innerHTML = ""; }

  function openStudent(r) {
    const m = $("modal");
    m.classList.remove("hidden");
    m.innerHTML = `<div class="card modal-box">
      <div class="row between"><b>학생 정보</b><button class="link" id="close">닫기 ✕</button></div>
      <p class="muted small">계정: ${esc(r.email || "(알 수 없음)")}</p>
      <label>반<select id="stCls">${state.classes.concat(TEST_CLASS).map((c) => `<option ${c === r.classId ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>번호<input id="stNum" type="number" inputmode="numeric" min="0" max="99" value="${esc(r.number ?? "")}"></label>
      <label>이름<input id="stName" maxlength="30" value="${esc(r.name ?? "")}"></label>
      <div class="row between wrap gap">
        <button class="btn danger" id="stReset">정보 초기화</button>
        <button class="btn primary" id="stSave">저장</button>
      </div>
      <p class="muted small"><b>저장</b>: 선생님이 직접 고쳐요. 이 학생의 지난 점수 기록에도 함께 반영돼요.<br>
      <b>정보 초기화</b>: 학생 정보만 지워요 (점수·녹음은 남아요). 학생이 다음에 앱을 열면 반·번호·이름을 다시 입력해요.</p>
      <div id="stConfirm"></div>
      <hr class="sep">
      <b>이 수업 기록</b> <span class="muted small">(${esc(lesson.title)} · 저장한 문장 ${Object.keys(r.at).length}개)</span>
      <p class="muted small">이 학생의 이 수업 <b>점수와 녹음을 모두</b> 지워요. 학생은 1번 문장부터 다시 해야 해요. 다른 수업 기록은 그대로예요.</p>
      <button class="btn danger" id="stRedoLesson" ${Object.keys(r.at).length ? "" : "disabled"}>이 수업 전체 다시 하게 하기</button>
      <div id="stRedoConfirm"></div>
    </div>`;
    const close = () => { m.classList.add("hidden"); m.innerHTML = ""; };
    m.onclick = (e) => { if (e.target === m || e.target.id === "close") close(); };
    if (!r.email) {
      // 학생 정보 문서가 없는(이미 초기화된) 학생
      $("stReset").disabled = true;
    }
    $("stRedoLesson").addEventListener("click", () => {
      askConfirm($("stRedoConfirm"), `${esc(r.name)} 학생의 「${esc(lesson.title)}」 점수와 녹음을 모두 지울까요? 되돌릴 수 없어요.`, "네, 전체 다시 하게 하기", async () => {
        const at = await getDocs(query(collection(db, "attempts"), where("uid", "==", r.uid), where("lessonId", "==", lesson.id)));
        await deleteAttempts(at.docs.map((d) => d.id));
        toast(`${r.name} 학생의 이 수업 기록 ${at.docs.length}개를 지웠어요. 학생이 앱을 새로 열면 1번 문장부터 시작해요.`, 6000);
        closeModal();
        load();
      });
    });
    $("stSave").addEventListener("click", async () => {
      const classId = $("stCls").value;
      const number = parseInt($("stNum").value, 10);
      const name = $("stName").value.trim();
      if (!name || !(number >= 0 && number <= 99)) return toast("번호와 이름을 입력하세요.");
      $("stSave").disabled = true;
      try {
        const data = { classId, number, name, email: r.email || "", updatedAt: serverTimestamp() };
        await setDoc(doc(db, "users", r.uid), data);
        await syncAttemptProfile(r.uid, data);
        toast("학생 정보를 고쳤어요.");
        close();
        load();
      } catch (e) { toast(errMsg(e)); $("stSave").disabled = false; }
    });
    // 초기화는 한 번 더 확인
    $("stReset").addEventListener("click", () => {
      $("stConfirm").innerHTML = `<div class="dup-note">${esc(r.name)} 학생의 정보를 초기화할까요?
        <div class="row gap" style="margin-top:8px"><button class="btn danger" id="stResetYes">네, 초기화</button><button class="btn" id="stResetNo">취소</button></div></div>`;
      $("stResetNo").addEventListener("click", () => { $("stConfirm").innerHTML = ""; });
      $("stResetYes").addEventListener("click", async () => {
        try {
          await deleteDoc(doc(db, "users", r.uid));
          toast("초기화했어요. 학생이 앱을 다시 열면 정보를 새로 입력해요.", 5000);
          close();
          load();
        } catch (e) { toast(errMsg(e)); }
      });
    });
  }

  async function openDetail(r, i) {
    const a = r.at[i];
    const s = lesson.sentences[i];
    const m = $("modal");
    m.classList.remove("hidden");
    m.innerHTML = `<div class="card modal-box">
      <div class="row between"><b>${esc(r.number)}번 ${esc(r.name)} · ${i + 1}번 문장</b><button class="link" id="close">닫기 ✕</button></div>
      <p class="sentence small-s">${a.words?.length ? a.words.filter((w) => w.e !== "Insertion").map((w) => `<span class="w ${w.e === "Omission" ? "omit" : scoreClass(w.s)}">${esc(w.w)}</span>`).join(" ") : esc(s.text)}</p>
      <p class="muted small">AI가 들은 말: ${esc(a.heard || "(인식 안 됨)")}</p>
      <p>점수 <b>${a.pron}%</b>${a.speed ? ` · 말하기 길이 원음의 ${a.speed}배` : ""}</p>
      <p class="muted small">시도 ${a.tries}회 · 최고 ${a.best}% · ${a.updatedAt?.toDate ? a.updatedAt.toDate().toLocaleString("ko-KR") : ""}</p>
      <audio id="aud" controls preload="none"></audio>
      <hr class="sep">
      <button class="btn danger" id="redoOne">이 문장 다시 하게 하기</button>
      <p class="muted small">이 문장의 점수와 녹음을 지워요. 학생은 이 문장을 다시 녹음해서 ${passScore + 1}% 이상 저장해야 다음 문장으로 넘어가요.</p>
      <div id="redoConfirm"></div>
    </div>`;
    m.onclick = (e) => { if (e.target === m || e.target.id === "close") closeModal(); };
    $("redoOne").addEventListener("click", () => {
      askConfirm($("redoConfirm"), `${esc(r.name)} 학생의 ${i + 1}번 문장 점수와 녹음을 지울까요? 되돌릴 수 없어요.`, "네, 다시 하게 하기", async () => {
        await deleteAttempts([`${r.uid}_${lesson.id}_${i}`]);
        toast(`${r.name} 학생의 ${i + 1}번 문장을 지웠어요. 학생이 앱을 새로 열면 이 문장부터 다시 해요.`, 6000);
        closeModal();
        load();
      });
    });
    try {
      const url = await recordingUrl(`${r.uid}_${lesson.id}_${i}`);
      if (url) $("aud").src = url; else $("aud").outerHTML = `<p class="muted small">녹음 파일이 없습니다.</p>`;
    } catch (_) {}
  }

  function exportCsv() {
    if (!lesson || !rows.length) return;
    const n = (lesson.sentences || []).length;
    const lines = [["번호", "이름", "계정", "완료", "평균", ...Array.from({ length: n }, (_, i) => `${i + 1}번`)]];
    rows.forEach((r) => {
      const sc = Object.values(r.at).map((a) => a.pron);
      const avg = sc.length ? Math.round(sc.reduce((a, b) => a + b, 0) / sc.length) : "";
      lines.push([r.number, r.name, (r.email || "").split("@")[0], sc.length, avg, ...Array.from({ length: n }, (_, i) => r.at[i]?.pron ?? "")]);
    });
    const csv = "﻿" + lines.map((l) => l.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `${lesson.title}_${$("cls").value}.csv`;
    a.click();
  }

  $("clearTest").addEventListener("click", async () => {
    if (!confirm("이 수업의 '테스트' 반 기록과 녹음을 모두 지울까요?")) return;
    try {
      const at = await getDocs(query(collection(db, "attempts"), where("lessonId", "==", $("lesson").value), where("classId", "==", TEST_CLASS)));
      const batch = writeBatch(db);
      at.docs.forEach((d) => { batch.delete(doc(db, "attempts", d.id)); batch.delete(doc(db, "recordings", d.id)); });
      await batch.commit();
      toast(`테스트 기록 ${at.docs.length}개를 지웠어요.`);
      load();
    } catch (e) { toast(errMsg(e)); }
  });
  $("lesson").addEventListener("change", load);
  $("cls").addEventListener("change", load);
  $("reload").addEventListener("click", load);
  $("csv").addEventListener("click", exportCsv);
  $("table").addEventListener("click", (e) => {
    const st = e.target.closest(".student");
    if (st) return openStudent(rows[Number(st.dataset.r)]);
    const b = e.target.closest(".cell");
    if (b) openDetail(rows[Number(b.dataset.r)], Number(b.dataset.i));
  });
  load();
}

// 수업 자료 목록
async function viewLessons() {
  render(`${header(teacherTabs("#/lessons"))}<main>
    <div class="row between"><h2>수업 자료</h2><a class="btn primary" href="#/edit/new">+ 새 수업 만들기</a></div>
    <div id="list" class="muted">불러오는 중…</div>
  </main>`);
  bindHeader();
  const el = document.getElementById("list");
  try {
    const lessons = await getAllLessons();
    if (!lessons.length) { el.textContent = "아직 수업이 없습니다."; return; }
    el.className = "lesson-list";
    el.innerHTML = lessons.map((l) => `<div class="card lesson">
      <div><b>${esc(l.title)}</b>
        <div class="muted small">${(l.sentences || []).length}문장 · ${(l.classes || []).map(esc).join(", ") || "반 없음"}</div></div>
      <div class="row gap">
        <span class="badge ${l.published ? "on" : ""}">${l.published ? "공개" : "비공개"}</span>
        <a class="btn" href="#/practice/${l.id}">미리보기</a>
        <a class="btn" href="#/edit/${l.id}">수정</a>
        <button class="btn danger" data-clear="${l.id}">녹음 지우기</button>
      </div>
    </div>`).join("");
    el.addEventListener("click", async (e) => {
      const lessonId = e.target.dataset?.clear;
      if (!lessonId) return;
      const title = lessons.find((l) => l.id === lessonId)?.title;
      if (!confirm(`"${title}" 학생 녹음 파일을 모두 지울까요?\n점수 기록은 남고, 저장 공간만 비워집니다.`)) return;
      e.target.disabled = true;
      try {
        const at = await getDocs(query(collection(db, "attempts"), where("lessonId", "==", lessonId)));
        let batch = writeBatch(db), n = 0;
        for (const d of at.docs) {
          batch.delete(doc(db, "recordings", d.id));
          if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
        }
        await batch.commit();
        toast(`녹음 ${n}개를 지웠습니다.`);
      } catch (err) { toast(errMsg(err)); }
      e.target.disabled = false;
    });
  } catch (e) { el.textContent = errMsg(e); }
}

// 수업 만들기 / 수정
// 원음 방식 두 가지: "files" = 문장마다 파일 1개 / "single" = 긴 파일 1개를 자동으로 나누기
async function viewEditor(lessonId) {
  const isNew = lessonId === "new";
  let lesson = { title: "", classes: [], sentences: [], published: true, mode: "files" };
  if (!isNew) {
    const snap = await getDoc(doc(db, "lessons", lessonId));
    if (!snap.exists()) return render(`${header(teacherTabs("#/lessons"))}<main>수업을 찾을 수 없습니다.</main>`);
    lesson = snap.data();
  }
  const id = isNew ? doc(collection(db, "lessons")).id : lessonId;
  let mode = lesson.mode === "files" ? "files" : isNew ? "files" : "single";
  // single 방식
  let file = null, buffer = null, player = null;
  let rows = mode === "single" ? (lesson.sentences || []).map((x) => ({ ...x })) : [];
  // files 방식: { text, file?, audio?, end, url? }
  let items = mode === "files" ? (lesson.sentences || []).map((x) => ({ text: x.text, audio: x.audio, end: x.end })) : [];
  let itemPlayer = null;

  render(`${header(teacherTabs("#/lessons"))}<main class="editor">
    <a href="#/lessons" class="link">← 수업 자료</a>
    <h2>${isNew ? "새 수업 만들기" : "수업 수정"}</h2>
    <div class="card">
      <label>제목<input id="title" value="${esc(lesson.title)}" placeholder="예: Lesson 3 Dialogue"></label>
      <div class="field"><span>공개할 반</span><div class="row gap wrap">
        ${state.classes.map((c) => `<label class="check"><input type="checkbox" class="cls" value="${esc(c)}" ${lesson.classes.includes(c) ? "checked" : ""}> ${esc(c)}</label>`).join("")}
        <button class="link" id="allcls">모두 선택</button>
      </div></div>
      <div class="field"><span>원음 올리는 방식</span>
        <div class="mode-pick">
          <label class="check"><input type="radio" name="mode" value="files" ${mode === "files" ? "checked" : ""}> <b>문장별 파일 여러 개</b> <span class="muted small">(파일 1개 = 문장 1개)</span></label>
          <label class="check"><input type="radio" name="mode" value="single" ${mode === "single" ? "checked" : ""}> <b>긴 파일 1개</b> <span class="muted small">(앱이 문장별로 나눠 줌)</span></label>
        </div>
      </div>

      <div id="filesBox">
        <label>문장별 원음 파일 (여러 개를 한 번에 선택하세요)<input type="file" id="files" multiple accept="audio/*,.mp3,.m4a,.wav"></label>
        <p class="muted small">파일 이름 순서(01, 02, 03…)대로 문장 번호가 정해져요. 순서는 아래에서 ↑ ↓로 바꿀 수 있어요.</p>
        <label>대본 (한 줄에 한 문장, 파일 순서와 같게)<textarea id="script2" rows="6" placeholder="Remember this.&#10;Hold the door.">${esc(items.map((x) => x.text).join("\n"))}</textarea></label>
        <button class="btn primary" id="fill">대본을 파일 순서대로 넣기</button>
      </div>

      <div id="singleBox">
        <label>원음 파일 (mp3, m4a, wav)${lesson.audioChunks ? " — 바꿀 때만 선택" : ""}<input type="file" id="file" accept="audio/*,.mp3,.m4a,.wav"></label>
        <label>대본 (한 줄에 한 문장이 가장 정확해요)<textarea id="script" rows="8" placeholder="Hello, my name is Tom.&#10;Nice to meet you.">${esc(rows.map((r) => r.text).join("\n"))}</textarea></label>
        <button class="btn primary" id="split">문장 나누기 + 소리 구간 자동 찾기</button>
        <p class="muted small">자동으로 찾은 구간이 조금 틀릴 수 있어요. 아래에서 ▶로 들어 보고 ◀ ▶ 버튼으로 0.1초씩 조절하세요.</p>
      </div>
    </div>
    <div id="rows"></div>
    <div class="card">
      <label class="check"><input type="checkbox" id="pub" ${lesson.published ? "checked" : ""}> 학생에게 공개</label>
      <div class="row between">
        ${isNew ? "<span></span>" : `<button class="btn danger" id="del">수업 삭제</button>`}
        <button class="btn big primary" id="save">저장</button>
      </div>
    </div>
  </main>`);
  bindHeader();
  cleanup = () => { player?.stop(); itemPlayer?.stop(); };
  const $ = (x) => document.getElementById(x);

  function showMode() {
    $("filesBox").hidden = mode !== "files";
    $("singleBox").hidden = mode !== "single";
    draw();
  }
  document.querySelectorAll("[name=mode]").forEach((r) => r.addEventListener("change", () => {
    readAll();
    mode = r.value;
    showMode();
  }));

  if (lesson.mode !== "files" && lesson.audioChunks) {
    audioUrl(id, lessonAudioRefs(lesson)[0]).then((u) => { if (!file) player = new SegmentPlayer(u); }).catch(() => {});
  }

  // ---------- 그리기 ----------
  function draw() { mode === "files" ? drawItems() : drawRows(); }

  function drawItems() {
    $("rows").innerHTML = items.length ? `<div class="card">${items.map((it, i) => `
      <div class="seg item" data-i="${i}">
        <div class="seg-top"><b>${i + 1}</b><input class="txt" value="${esc(it.text)}" placeholder="이 파일의 문장을 입력하세요"><button class="btn sm" data-act="play">▶ 듣기</button></div>
        <div class="seg-time">
          <span class="fname">${esc(it.file ? it.file.name : "저장된 원음")}${it.end ? ` · ${it.end.toFixed(1)}초` : ""}</span>
          <span class="spacer"></span>
          <button class="chip" data-act="up" ${i === 0 ? "disabled" : ""} aria-label="위로">↑</button>
          <button class="chip" data-act="down" ${i === items.length - 1 ? "disabled" : ""} aria-label="아래로">↓</button>
          <button class="chip" data-act="remove" aria-label="빼기">✕</button>
        </div>
      </div>`).join("")}</div>` : "";
  }

  function drawRows() {
    $("rows").innerHTML = rows.length ? `<div class="card">${rows.map((r, i) => `
      <div class="seg" data-i="${i}">
        <div class="seg-top"><b>${i + 1}</b><input class="txt" value="${esc(r.text)}"><button class="btn sm" data-act="play">▶ 듣기</button></div>
        <div class="seg-time">
          시작 <button class="chip" data-act="s-">◀</button><input class="num s" type="number" step="0.05" value="${r.start}"><button class="chip" data-act="s+">▶</button>
          끝 <button class="chip" data-act="e-">◀</button><input class="num e" type="number" step="0.05" value="${r.end}"><button class="chip" data-act="e+">▶</button>
        </div>
      </div>`).join("")}</div>` : "";
  }

  function readAll() {
    document.querySelectorAll(".seg").forEach((el) => {
      const i = Number(el.dataset.i);
      if (el.classList.contains("item")) {
        if (items[i]) items[i].text = el.querySelector(".txt").value.trim();
      } else if (rows[i]) {
        rows[i].text = el.querySelector(".txt").value.trim();
        rows[i].start = Number(el.querySelector(".s").value) || 0;
        rows[i].end = Number(el.querySelector(".e").value) || 0;
      }
    });
  }

  $("allcls").addEventListener("click", () => document.querySelectorAll(".cls").forEach((c) => (c.checked = true)));

  // ---------- 문장별 파일 ----------
  const fileDuration = (f) => new Promise((resolve) => {
    const a = new Audio();
    const u = URL.createObjectURL(f);
    a.preload = "metadata";
    a.onloadedmetadata = () => { resolve(isFinite(a.duration) ? a.duration : 0); URL.revokeObjectURL(u); };
    a.onerror = () => { resolve(0); URL.revokeObjectURL(u); };
    a.src = u;
  });

  $("files").addEventListener("change", async (e) => {
    readAll();
    const picked = [...e.target.files]
      .sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: "base" }));
    e.target.value = "";
    const tooBig = picked.filter((f) => f.size > MAX_LESSON_AUDIO);
    if (tooBig.length) toast(`너무 큰 파일은 뺐어요 (15MB 이하): ${tooBig.map((f) => f.name).join(", ")}`, 6000);
    const ok = picked.filter((f) => f.size <= MAX_LESSON_AUDIO);
    const added = await Promise.all(ok.map(async (f) => ({ text: "", file: f, end: Math.round((await fileDuration(f)) * 100) / 100 })));
    items = items.concat(added);
    // 대본이 이미 있으면 빈 칸을 순서대로 채움
    const lines = splitSentences($("script2").value);
    items.forEach((it, i) => { if (!it.text && lines[i]) it.text = lines[i]; });
    drawItems();
    if (added.length) toast(`파일 ${added.length}개를 넣었어요. 문장이 맞는지 확인하세요.`);
  });

  $("fill").addEventListener("click", () => {
    const lines = splitSentences($("script2").value);
    if (!lines.length) return toast("대본을 입력하세요.");
    if (!items.length) return toast("먼저 문장별 원음 파일을 선택하세요.");
    items.forEach((it, i) => { it.text = lines[i] || ""; });
    drawItems();
    if (lines.length !== items.length) {
      toast(`대본 ${lines.length}줄, 파일 ${items.length}개로 개수가 달라요. 빈 칸이나 남는 줄을 확인하세요.`, 6000);
    }
  });

  // ---------- 긴 파일 1개 ----------
  $("file").addEventListener("change", async (e) => {
    file = e.target.files[0] || null;
    buffer = null;
    if (!file) return;
    if (file.size > MAX_LESSON_AUDIO) {
      toast("파일이 너무 커요 (15MB 이하). 수업에 쓸 부분만 잘라서 mp3로 올려 주세요.", 6000);
      e.target.value = ""; file = null; return;
    }
    player?.stop();
    player = new SegmentPlayer(URL.createObjectURL(file));
    try { buffer = await decodeAudio(await file.arrayBuffer()); }
    catch (_) { toast("이 오디오 파일은 자동 구간 찾기를 할 수 없어요. mp3나 wav로 바꿔 보세요.", 6000); }
  });

  $("split").addEventListener("click", async () => {
    const texts = splitSentences($("script").value);
    if (!texts.length) return toast("대본을 입력하세요.");
    let segs;
    if (buffer) segs = autoSegment(buffer, texts.length);
    else if (player) {
      await player.ready.catch(() => {});
      const d = player.duration, step = d / texts.length;
      segs = texts.map((_, k) => ({ start: +(k * step).toFixed(2), end: +((k + 1) * step).toFixed(2) }));
      toast("원음 파일을 새로 선택하면 구간을 자동으로 찾아 줘요.");
    } else return toast("먼저 원음 파일을 선택하세요.");
    rows = texts.map((t, k) => ({ text: t, ...segs[k] }));
    drawRows();
  });

  // ---------- 목록 버튼 ----------
  $("rows").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const el = b.closest(".seg");
    readAll();
    const i = Number(el.dataset.i);
    const act = b.dataset.act;

    if (el.classList.contains("item")) {
      const it = items[i];
      if (act === "play") {
        try {
          itemPlayer?.stop();
          if (!it.url) it.url = it.file ? URL.createObjectURL(it.file) : await audioUrl(id, it.audio);
          itemPlayer = new SegmentPlayer(it.url);
          await itemPlayer.play(0, Infinity);
        } catch (err) { toast(err.message); }
        return;
      }
      if (act === "up" && i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
      if (act === "down" && i < items.length - 1) [items[i + 1], items[i]] = [items[i], items[i + 1]];
      if (act === "remove") items.splice(i, 1);
      return drawItems();
    }

    const r = rows[i];
    if (act === "play") {
      if (!player) return toast("원음 파일이 없습니다.");
      return player.play(r.start, r.end).catch((err) => toast(err.message));
    }
    const d = act.endsWith("+") ? 0.1 : -0.1;
    if (act[0] === "s") r.start = Math.max(0, +(r.start + d).toFixed(2));
    else r.end = Math.max(r.start + 0.1, +(r.end + d).toFixed(2));
    el.querySelector(".s").value = r.start;
    el.querySelector(".e").value = r.end;
    if (player) player.play(act[0] === "s" ? r.start : Math.max(r.start, r.end - 1.5), r.end);
  });

  // ---------- 저장 ----------
  $("save").addEventListener("click", async () => {
    readAll();
    const title = $("title").value.trim();
    const classes = [...document.querySelectorAll(".cls:checked")].map((c) => c.value);
    if (!title) return toast("제목을 입력하세요.");
    if (mode === "files") {
      if (!items.length) return toast("문장별 원음 파일을 선택하세요.");
      const empty = items.findIndex((it) => !it.text);
      if (empty >= 0) return toast(`${empty + 1}번 문장이 비어 있어요. 문장을 입력하세요.`);
    } else {
      if (!rows.length || rows.some((r) => !r.text)) return toast("문장 나누기를 먼저 해 주세요.");
      if (rows.some((r) => !(r.end > r.start))) return toast("끝 시간이 시작 시간보다 커야 해요.");
      if (!file && !lesson.audioChunks) return toast("원음 파일을 선택하세요.");
    }
    $("save").disabled = true;
    $("save").textContent = "저장 중…";
    try {
      const oldRefs = lessonAudioRefs(lesson);
      let data;
      if (mode === "files") {
        const sentences = [];
        for (let k = 0; k < items.length; k++) {
          const it = items[k];
          $("save").textContent = `원음 올리는 중… ${k + 1} / ${items.length}`;
          const audio = it.file ? await saveAudio(id, it.file, `s${k}`) : it.audio;
          sentences.push({ text: it.text, start: 0, end: it.end || 0, audio });
        }
        data = { mode: "files", sentences };
      } else {
        let ref = oldRefs[0];
        if (file) {
          $("save").textContent = "원음 올리는 중…";
          ref = await saveAudio(id, file);
        }
        data = {
          mode: "single", audioVersion: ref.v, audioChunks: ref.n, audioMime: ref.mime,
          sentences: rows.map((r) => ({ text: r.text, start: r.start, end: r.end })),
        };
      }
      await setDoc(doc(db, "lessons", id), {
        title, classes, ...data,
        published: $("pub").checked,
        createdAt: lesson.createdAt || serverTimestamp(),
      });
      // 더 이상 쓰지 않는 원음 지우기
      const keep = new Set(lessonAudioRefs(data).map((r) => r.v));
      oldRefs.filter((r) => !keep.has(r.v)).forEach((r) => deleteAudio(id, r));
      toast("저장했습니다.");
      location.hash = "#/lessons";
    } catch (e) {
      toast(errMsg(e), 6000);
      $("save").disabled = false;
      $("save").textContent = "저장";
    }
  });

  $("del")?.addEventListener("click", async () => {
    if (!confirm("이 수업을 삭제할까요? (학생 점수 기록은 남습니다)")) return;
    try {
      await deleteDoc(doc(db, "lessons", id));
      lessonAudioRefs(lesson).forEach((r) => deleteAudio(id, r));
      location.hash = "#/lessons";
    } catch (e) { toast(errMsg(e)); }
  });

  showMode();
}

// 설정
function viewSettings() {
  render(`${header(teacherTabs("#/settings"))}<main class="narrow">
    <div class="card">
      <h2>반 목록</h2>
      <p class="muted small">한 줄에 한 반씩. 학생은 처음 로그인할 때 이 중에서 반을 고릅니다.</p>
      <textarea id="classes" rows="8">${esc(state.classes.join("\n"))}</textarea>
      <button class="btn primary" id="save">저장</button>
    </div>
  </main>`);
  bindHeader();
  document.getElementById("save").addEventListener("click", async () => {
    const classes = document.getElementById("classes").value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!classes.length) return toast("반을 하나 이상 입력하세요.");
    try {
      await setDoc(doc(db, "meta", "settings"), { classes });
      state.classes = classes;
      toast("저장했습니다.");
    } catch (e) { toast(errMsg(e)); }
  });
}

// ---------- 화면 이동 ----------
function route() {
  if (!state.user) return viewLogin();
  const [, page, arg] = (location.hash || "#/").replace(/^#/, "").split("/");
  if (state.isTeacher && page === "test" && !state.testMode) return setTestMode(true);
  if (state.isTeacher && !state.testMode) {
    if (page === "lessons") return viewLessons();
    if (page === "edit") return viewEditor(arg);
    if (page === "settings") return viewSettings();
    if (page === "practice") return viewPractice(arg);
    return viewResults();
  }
  if (!state.profile) return viewProfile();
  if (page === "practice") return viewPractice(arg);
  return viewStudentHome();
}

window.addEventListener("hashchange", route);

getRedirectResult(auth).catch((e) => {
  if (e.code === "auth/account-exists-with-different-credential") {
    toast("이 이메일은 다른 방법으로 이미 가입되어 있어요. 처음에 사용한 로그인 버튼을 눌러 주세요.", 6000);
  }
});

function isSchoolEmail(email) {
  if (!allowedDomains.length) return true;
  const e = String(email || "").toLowerCase();
  return allowedDomains.some((d) => e.endsWith("@" + d.toLowerCase()));
}

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  state.isTeacher = false;
  state.testMode = false;
  state.profile = null;
  if (!user) { try { sessionStorage.removeItem("test-mode"); } catch (_) {} }
  if (user && !isSchoolEmail(user.email)) {
    const email = user.email || "(이메일 없음)";
    await signOut(auth);
    viewLogin();
    return toast(`${email} 계정은 사용할 수 없어요. 학교 계정(@${allowedDomains.join(", @")})으로 로그인하세요.`, 7000);
  }
  if (user) {
    render(`<main class="center muted">불러오는 중…</main>`);
    try { await getDoc(doc(db, "meta", "teacherCheck")); state.isTeacher = true; } catch (_) {}
    await loadSettings();
    try { state.testMode = state.isTeacher && sessionStorage.getItem("test-mode") === "1"; } catch (_) {}
    if (actingAsStudent()) {
      try {
        const p = await getDoc(doc(db, "users", user.uid));
        if (p.exists()) state.profile = p.data();
      } catch (_) {}
      if (state.testMode && !state.profile) state.profile = { ...TEST_PROFILE };
    }
  }
  route();
});
