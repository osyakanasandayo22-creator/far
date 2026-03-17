import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js";
import {
  GoogleAuthProvider,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  doc,
  getDoc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDkcAkyKHwoAVjhZd5tJI9B6ilH6UgeFyg",
  authDomain: "farword-6e2d8.firebaseapp.com",
  projectId: "farword-6e2d8",
  storageBucket: "farword-6e2d8.firebasestorage.app",
  messagingSenderId: "191455087675",
  appId: "1:191455087675:web:2b3fc381ae1a079e1b601e",
  measurementId: "G-SN0TRL3Q1N",
};

const app = initializeApp(firebaseConfig);
try {
  // localhostなど一部環境では失敗することがあるので握りつぶす
  getAnalytics(app);
} catch {
  // noop
}

const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let currentUser = null;
let currentProfile = null;
let currentOpponent = null;
let currentMatchId = null;
let matchUnsub = null;
let activeTimers = new Set();
let activeMatchToken = 0;
let prepCountdownStarted = false;

function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el;
}

function clearTimers() {
  for (const t of activeTimers) clearTimeout(t);
  activeTimers.clear();
}

function cleanupMatchSub() {
  if (typeof matchUnsub === "function") matchUnsub();
  matchUnsub = null;
}

function later(ms, fn) {
  const t = setTimeout(() => {
    activeTimers.delete(t);
    fn();
  }, ms);
  activeTimers.add(t);
  return t;
}

function getRoute() {
  const hash = location.hash || "#/";
  const route = hash.replace(/^#/, "");
  return route.startsWith("/") ? route : "/";
}

function navigate(route) {
  location.hash = `#${route}`;
}

function setText(el, text) {
  el.textContent = text;
}

function setHidden(el, hidden) {
  el.hidden = !!hidden;
}

function normalizeDisplayName(name) {
  if (typeof name !== "string") return "";
  return name.trim().slice(0, 20);
}

function getEffectiveName(user, profile) {
  const fromProfile = profile?.displayName;
  const fromAuth = user?.displayName;
  return (
    normalizeDisplayName(fromProfile) ||
    normalizeDisplayName(fromAuth) ||
    "ユーザー"
  );
}

function getAvatarSeed(name) {
  const s = String(name || "user");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function renderAvatar(el, name) {
  const seed = getAvatarSeed(name);
  const a = (seed % 360) | 0;
  const b = ((seed / 7) % 360) | 0;
  el.style.background = `linear-gradient(135deg, hsla(${a}, 92%, 62%, 0.9), hsla(${b}, 92%, 62%, 0.75))`;
  el.textContent = (String(name || "?").trim()[0] || "?").toUpperCase();
}

function makeDummyOpponent() {
  const pool = [
    { displayName: "ことばの旅人", rank: "ブロンズ", mood: "ゆるく勝ちたい" },
    { displayName: "遠回り名人", rank: "シルバー", mood: "センス勝負" },
    { displayName: "比喩コレクター", rank: "ゴールド", mood: "全力で遊ぶ" },
    { displayName: "たとえ番長", rank: "プラチナ", mood: "一言で刺す" },
  ];
  const pick = pool[(Math.random() * pool.length) | 0];
  return {
    uid: `dummy_${Math.random().toString(16).slice(2)}`,
    displayName: pick.displayName,
    rank: pick.rank,
    mood: pick.mood,
  };
}

function makePrompt() {
  const prompts = [
    "「春」を遠い言葉で言うと？",
    "「雨上がり」を遠い言葉で言うと？",
    "「初恋」を遠い言葉で言うと？",
    "「駅のホーム」を遠い言葉で言うと？",
    "「さよなら」を遠い言葉で言うと？",
  ];
  return prompts[(Math.random() * prompts.length) | 0];
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.error || `APIエラー（${res.status}）`;
    throw new Error(msg);
  }
  return data;
}

async function ensureUserDoc(user, preferredDisplayName) {
  if (!user?.uid) return;
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);

  const nextDisplayName = normalizeDisplayName(
    preferredDisplayName || user.displayName || ""
  );

  if (!snap.exists()) {
    await setDoc(ref, {
      displayName: nextDisplayName || "ユーザー",
      photoURL: user.photoURL || null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return;
  }

  // 既存ユーザーは、入力があった場合のみdisplayNameを更新
  if (nextDisplayName) {
    await setDoc(
      ref,
      {
        displayName: nextDisplayName,
        photoURL: user.photoURL || null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } else {
    await setDoc(
      ref,
      {
        photoURL: user.photoURL || null,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }
}

async function loadProfile(uid) {
  if (!uid) return null;
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return snap.data() || null;
}

function startPrepSequence(opponent, { matchToken } = {}) {
  currentOpponent = opponent || null;
  const prepStatus = $("prepStatus");
  const prepHint = $("prepHint");
  const opponentCard = $("opponentCard");
  const opponentName = $("opponentName");
  const opponentMeta = $("opponentMeta");
  const opponentAvatar = $("opponentAvatar");
  const prepCountdown = $("prepCountdown");

  setText(prepStatus, "相手が見つかりました。");
  setText(prepHint, "3秒後に対戦を開始します。");
  setHidden(opponentCard, false);
  setText(opponentName, opponent?.displayName || "対戦相手");
  setText(
    opponentMeta,
    `${opponent?.rank ? `ランク: ${opponent.rank}` : ""}${
      opponent?.mood ? `${opponent?.rank ? " / " : ""}${opponent.mood}` : ""
    }`
  );
  renderAvatar(opponentAvatar, opponent?.displayName || "？");

  if (prepCountdownStarted) return;
  prepCountdownStarted = true;

  const startedAt = Date.now();
  const totalMs = 3000;
  function tick() {
    const elapsed = Date.now() - startedAt;
    const left = Math.max(0, totalMs - elapsed);
    const sec = Math.ceil(left / 1000);
    setText(prepCountdown, `開始まで ${sec}…`);
    if (left <= 0) {
      // 遷移前に画面が変わっていたら中止
      if (getRoute() !== "/prep") return;
      if (typeof matchToken === "number" && matchToken !== activeMatchToken) return;
      navigate("/battle");
      return;
    }
    later(120, tick);
  }
  tick();
}

async function cancelMatchmaking({ silent } = {}) {
  activeMatchToken++;
  clearTimers();
  prepCountdownStarted = false;
  currentOpponent = null;
  currentMatchId = null;
  cleanupMatchSub();

  // queueを片付け（失敗しても体験は継続できる）
  try {
    if (currentUser?.uid) await apiPost("/api/leaveQueue", { uid: currentUser.uid });
  } catch {
    // noop
  }

  if (!silent) {
    navigate("/lobby");
    render();
  }
}

async function startMatchmaking() {
  if (!currentUser) {
    openLoginModal();
    return;
  }
  activeMatchToken++;
  const myToken = activeMatchToken;
  clearTimers();
  prepCountdownStarted = false;
  currentOpponent = null;
  currentMatchId = null;
  cleanupMatchSub();

  navigate("/prep");
  const prepStatus = $("prepStatus");
  const prepHint = $("prepHint");
  const opponentCard = $("opponentCard");
  const prepCountdown = $("prepCountdown");
  setHidden(opponentCard, true);
  setText(prepCountdown, "");

  setText(prepStatus, "対戦相手を探しています…");
  setText(prepHint, "数秒かかる場合があります。");

  // 本番設計：マッチ作成はサーバー（Vercel API）に寄せる
  // - /api/joinQueue が queue/matches を作る
  // - クライアントは自分の queue/{uid} を監視して matchId を受け取る
  const myUid = currentUser.uid;
  const myName = getEffectiveName(currentUser, currentProfile);

  try {
    await apiPost("/api/joinQueue", { uid: myUid, displayName: myName });
  } catch (e) {
    setText(prepHint, "マッチング開始に失敗しました。通信状況を確認してください。");
    setText(prepStatus, "エラー");
    return;
  }

  const myQueueDoc = doc(db, "queue", myUid);
  const unsub = onSnapshot(myQueueDoc, (d) => {
    if (myToken !== activeMatchToken) return;
    if (getRoute() !== "/prep") return;
    const data = d.data() || null;
    const matchId = data?.matchId || null;
    if (!matchId) return;

    unsub();
    currentMatchId = matchId;
    watchMatch(matchId);
  });
}

function watchMatch(matchId) {
  cleanupMatchSub();
  const myUid = currentUser?.uid;
  const ref = doc(db, "matches", matchId);
  matchUnsub = onSnapshot(ref, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data() || {};
    const players = data.players || [];
    const oppUid = players.find((u) => u !== myUid) || null;
    const answers = data.answers || {};

    // prep表示更新（相手が確定してれば見せる）
    if (getRoute() === "/prep") {
      const oppName = data.playerNames?.[oppUid] || data.opponentName || null;
      const opponent = { uid: oppUid, displayName: oppName || "対戦相手" };
      startPrepSequence(opponent, { matchToken: activeMatchToken });
    }

    // battle表示更新
    if (getRoute() === "/battle") {
      setText($("battleRoomId"), matchId.slice(0, 8));
      setText($("battlePrompt"), data.prompt || "-");
      const oppName = data.playerNames?.[oppUid] || currentOpponent?.displayName || "相手";
      setText($("battleOpponentName"), oppName);
      setText($("oppNameText"), oppName);

      const myAns = answers?.[myUid]?.text || "";
      const oppAns = oppUid ? answers?.[oppUid]?.text || "" : "";
      const both = !!myAns && !!oppAns;
      setHidden($("resultCard"), !both);
      setText($("myAnswerText"), myAns || "-");
      setText($("oppAnswerText"), oppAns || "-");
      const judge = data.judge || null;
      if (judge && data.phase === "done") {
        const isWinner = judge.winnerUid && judge.winnerUid === myUid;
        const title = judge.safe === false ? "判定: NG（不適切）" : isWinner ? "勝ち" : "負け";
        setText($("battlePhaseText"), `${title} — ${judge.reason || ""}`.trim());
      } else if (both) {
        setText($("battlePhaseText"), "両者の回答が揃いました。判定中…");
      } else {
        setText($("battlePhaseText"), "相手の回答を待っています…");
      }
    }
  });
}

async function submitAnswer(text) {
  if (!currentUser?.uid || !currentMatchId) return;
  const t = String(text || "").trim().slice(0, 30);
  if (!t) return;
  const ref = doc(db, "matches", currentMatchId);
  const uid = currentUser.uid;
  const key = `answers.${uid}`;
  await updateDoc(ref, {
    [key]: { text: t, at: serverTimestamp() },
    [`playerNames.${uid}`]: getEffectiveName(currentUser, currentProfile),
  });

  // 両者回答が揃ったらサーバーが判定する（冪等）
  try {
    await apiPost("/api/judge", { matchId: currentMatchId });
  } catch {
    // 判定は相手側やリトライで走るので、ここでは握りつぶす
  }
}

function render() {
  const route = getRoute();

  const homeView = $("homeView");
  const lobbyView = $("lobbyView");
  const prepView = $("prepView");
  const battleView = $("battleView");

  const loginBtn = $("loginBtn");
  const playBtn = $("playBtn");
  const logoutBtn = $("logoutBtn");
  const userchip = $("userchip");
  const userNameText = $("userNameText");
  const authStateText = $("authStateText");

  if (currentUser) {
    const name = getEffectiveName(currentUser, currentProfile);
    setHidden(userchip, false);
    setHidden(logoutBtn, false);
    setText(userNameText, name);
    setText(authStateText, `ログイン中（${name}）`);
    setText(loginBtn, "ログイン済み");
    loginBtn.disabled = true;
    playBtn.disabled = false;
  } else {
    setHidden(userchip, true);
    setHidden(logoutBtn, true);
    setText(userNameText, "");
    setText(authStateText, "未ログイン");
    setText(loginBtn, "ログイン");
    loginBtn.disabled = false;
    playBtn.disabled = false; // クリック時にログインを促す
  }

  const isHome = route === "/";
  const isLobby = route === "/lobby";
  const isPrep = route === "/prep";
  const isBattle = route === "/battle";

  setHidden(homeView, !isHome);
  setHidden(lobbyView, !isLobby);
  setHidden(prepView, !isPrep);
  setHidden(battleView, !isBattle);

  if ((isLobby || isPrep || isBattle) && !currentUser) {
    // ロビーはログイン必須（とりあえず）
    navigate("/");
    openLoginModal();
  }

  if (!isPrep) {
    // prep以外にいるときは、prepのカウントダウン暴発を防ぐ
    clearTimers();
    prepCountdownStarted = false;
  }

  if (isBattle) {
    const nameEl = $("battleOpponentName");
    setText(nameEl, currentOpponent?.displayName || "（未設定）");
    setText($("battleRoomId"), currentMatchId ? currentMatchId.slice(0, 8) : "-");
  }
}

function openLoginModal() {
  const modal = $("loginModal");
  const input = $("displayNameInput");
  if (typeof modal.showModal === "function") {
    modal.showModal();
  } else {
    // dialog未対応ブラウザ向け：最小フォールバック
    modal.setAttribute("open", "");
  }
  setTimeout(() => input.focus(), 0);
}

function closeLoginModal() {
  const modal = $("loginModal");
  if (typeof modal.close === "function") {
    modal.close();
  } else {
    modal.removeAttribute("open");
  }
}

function bind() {
  $("loginBtn").addEventListener("click", () => {
    openLoginModal();
  });

  $("playBtn").addEventListener("click", () => {
    if (!currentUser) {
      openLoginModal();
      return;
    }
    navigate("/lobby");
  });

  $("logoutBtn").addEventListener("click", () => {
    signOut(auth).finally(() => {
      navigate("/");
      render();
    });
  });

  $("backHomeLink").addEventListener("click", (e) => {
    e.preventDefault();
    navigate("/");
  });

  $("backLobbyLink").addEventListener("click", (e) => {
    e.preventDefault();
    clearTimers();
    navigate("/lobby");
    render();
  });

  $("backLobbyLink2").addEventListener("click", (e) => {
    e.preventDefault();
    clearTimers();
    navigate("/lobby");
    render();
  });

  $("closeLoginBtn").addEventListener("click", () => {
    closeLoginModal();
  });
  $("cancelLoginBtn").addEventListener("click", () => {
    closeLoginModal();
  });

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const preferredName = normalizeDisplayName($("displayNameInput").value);

    try {
      const res = await signInWithPopup(auth, provider);
      await ensureUserDoc(res.user, preferredName);
      currentProfile = await loadProfile(res.user.uid);
      closeLoginModal();
      render();
    } catch (err) {
      // ポップアップ禁止などの場合はredirectにフォールバック
      try {
        await signInWithRedirect(auth, provider);
      } catch {
        const s = $("authStateText");
        setText(s, "ログインに失敗しました。ブラウザ設定を確認してください。");
      }
    }
  });

  $("queueBtn").addEventListener("click", () => {
    const s = $("queueStatus");
    setText(s, "準備画面へ移動します…");
    startMatchmaking();
  });

  $("cancelQueueBtn").addEventListener("click", async () => {
    const s = $("queueStatus");
    setText(s, "キャンセルしました。");
    await cancelMatchmaking({ silent: true });
  });

  $("cancelMatchBtn").addEventListener("click", async () => {
    await cancelMatchmaking();
  });

  $("answerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("answerInput");
    const status = $("answerStatus");
    const btn = $("submitAnswerBtn");
    const text = String(input.value || "").trim();
    if (!text) {
      setText(status, "回答を入力してください。");
      return;
    }
    btn.disabled = true;
    try {
      await submitAnswer(text);
      setText(status, "提出しました。相手の回答を待っています…");
      input.value = "";
    } catch {
      setText(status, "提出に失敗しました。通信状況を確認してください。");
    } finally {
      btn.disabled = false;
    }
  });

  $("joinRoomBtn").addEventListener("click", () => {
    if (!currentUser) {
      openLoginModal();
      return;
    }
    const roomId = $("roomIdInput").value.trim();
    const s = $("joinStatus");
    if (!roomId) {
      setText(s, "部屋IDを入力してください。");
      return;
    }
    setText(s, `「${roomId}」に参加（ダミー）`);
  });

  window.addEventListener("hashchange", render);
  window.addEventListener("beforeunload", () => {
    clearTimers();
    cleanupMatchSub();
  });

  // Escapeで閉じた場合も整える
  $("loginModal").addEventListener("close", () => {
    const input = $("displayNameInput");
    input.value = input.value.trim();
  });
}

bind();

// redirectログインの戻りを処理
getRedirectResult(auth)
  .then(async (res) => {
    if (res?.user) {
      const preferredName = normalizeDisplayName($("displayNameInput").value);
      await ensureUserDoc(res.user, preferredName);
    }
  })
  .catch(() => {
    // noop
  })
  .finally(() => {
    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      currentProfile = user ? await loadProfile(user.uid) : null;
      render();
    });
    render();
  });

