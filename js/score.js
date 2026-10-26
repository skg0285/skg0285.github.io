// 목표 문장과 인식된 문장을 단어 단위로 비교해 점수를 매깁니다.
const NUM = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20" };

export function norm(word) {
  const w = word.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9']/g, "").replace(/^'+|'+$/g, "");
  return NUM[w] || w;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function similarity(a, b) {
  if (a === b) return 1;
  return Math.max(0, 1 - editDistance(a, b) / Math.max(a.length, b.length, 1));
}

// 반환: { pron, words: [{w, s, e}], heard }
export function scoreSentence(reference, heard) {
  const ref = reference.split(/\s+/).map((w) => ({ w, n: norm(w) })).filter((t) => t.n);
  const hyp = heard.split(/\s+/).map(norm).filter(Boolean);
  const R = ref.length, H = hyp.length;
  // 단어 정렬 (비슷한 단어끼리 짝지음)
  const cost = Array.from({ length: R + 1 }, () => new Array(H + 1).fill(0));
  const back = Array.from({ length: R + 1 }, () => new Array(H + 1).fill(""));
  for (let i = 1; i <= R; i++) { cost[i][0] = i; back[i][0] = "del"; }
  for (let j = 1; j <= H; j++) { cost[0][j] = j; back[0][j] = "ins"; }
  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= H; j++) {
      const sim = similarity(ref[i - 1].n, hyp[j - 1]);
      const sub = cost[i - 1][j - 1] + (1 - sim);
      const del = cost[i - 1][j] + 1;
      const ins = cost[i][j - 1] + 1;
      const m = Math.min(sub, del, ins);
      cost[i][j] = m;
      back[i][j] = m === sub ? "sub" : m === del ? "del" : "ins";
    }
  }
  const words = new Array(R);
  let i = R, j = H;
  while (i > 0 || j > 0) {
    const b = back[i][j];
    if (b === "sub") {
      const s = Math.round(similarity(ref[i - 1].n, hyp[j - 1]) ** 2 * 100); // 비슷하기만 한 단어는 낮게
      words[i - 1] = { w: ref[i - 1].w, s: s < 40 ? 0 : s, e: s === 100 ? "None" : "Mispronunciation" };
      i--; j--;
    } else if (b === "del") {
      words[i - 1] = { w: ref[i - 1].w, s: 0, e: "Omission" };
      i--;
    } else j--;
  }
  const pron = R ? Math.round(words.reduce((a, w) => a + w.s, 0) / R) : 0;
  return { pron, words, heard };
}
