const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getDb, admin } = require("./_lib/firebaseAdmin");
const { send, readJson, requirePost } = require("./_lib/http");

function pickModel() {
  return process.env.GEMINI_MODEL || "gemini-1.5-flash";
}

function buildPrompt({ prompt, aUid, aName, aText, bUid, bName, bText }) {
  return [
    "あなたは日本語の審判です。",
    "次の『お題』に対して、2人の『遠い言葉』回答を評価してください。",
    "",
    "評価方針:",
    "- お題との距離感（遠さ）",
    "- ひと言の切れ味、比喩/連想の美しさ",
    "- 分かりやすさ（難解すぎない）",
    "- 不適切/攻撃的な内容は避ける（safe=falseにする）",
    "",
    "必ずJSONだけを返してください。説明文やコードフェンスは禁止。",
    "JSONスキーマ:",
    "{",
    '  "safe": boolean,',
    '  "winnerUid": string,',
    '  "scores": { "<uid>": number, "<uid>": number },',
    '  "reason": string',
    "}",
    "",
    `お題: ${prompt}`,
    "",
    `A uid=${aUid} name=${aName}`,
    `A 回答: ${aText}`,
    "",
    `B uid=${bUid} name=${bName}`,
    `B 回答: ${bText}`,
  ].join("\n");
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    // たまに前後にテキストが混ざるため、最初の{...}を拾う
    const m = String(s || "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function normalizeJudge(j, { aUid, bUid }) {
  const safe = !!j?.safe;
  const winnerUid = j?.winnerUid === aUid || j?.winnerUid === bUid ? j.winnerUid : aUid;
  const scores = {
    [aUid]: typeof j?.scores?.[aUid] === "number" ? j.scores[aUid] : 0,
    [bUid]: typeof j?.scores?.[bUid] === "number" ? j.scores[bUid] : 0,
  };
  const reason = typeof j?.reason === "string" ? j.reason.slice(0, 500) : "";
  return { safe, winnerUid, scores, reason };
}

module.exports = async (req, res) => {
  if (!requirePost(req, res)) return;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    send(res, 500, { error: "GEMINI_API_KEY が未設定です。" });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    send(res, 400, { error: e.message });
    return;
  }

  const matchId = typeof body.matchId === "string" ? body.matchId : "";
  if (!matchId) {
    send(res, 400, { error: "matchId が必要です。" });
    return;
  }

  const db = getDb();
  const ref = db.collection("matches").doc(matchId);

  try {
    const judged = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error("match が存在しません。");
      const m = snap.data() || {};
      if (m.judge && m.phase === "done") {
        return { already: true, judge: m.judge };
      }

      const players = Array.isArray(m.players) ? m.players : [];
      if (players.length !== 2) throw new Error("players が不正です。");
      const [aUid, bUid] = players;
      const answers = m.answers || {};
      const aText = answers?.[aUid]?.text;
      const bText = answers?.[bUid]?.text;
      if (typeof aText !== "string" || typeof bText !== "string" || !aText || !bText) {
        return { ready: false };
      }

      tx.update(ref, { phase: "judging" });

      return {
        ready: true,
        prompt: m.prompt || "",
        aUid,
        bUid,
        aName: m.playerNames?.[aUid] || "A",
        bName: m.playerNames?.[bUid] || "B",
        aText,
        bText,
      };
    });

    if (!judged?.ready) {
      send(res, 200, { ok: true, ready: false });
      return;
    }
    if (judged?.already) {
      send(res, 200, { ok: true, ready: true, already: true, judge: judged.judge });
      return;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: pickModel() });
    const prompt = buildPrompt(judged);

    const r = await model.generateContent(prompt);
    const text = r?.response?.text?.() || "";
    const parsed = safeJsonParse(text);
    const normalized = normalizeJudge(parsed, { aUid: judged.aUid, bUid: judged.bUid });

    await ref.update({
      judge: normalized,
      judgedAt: admin.firestore.FieldValue.serverTimestamp(),
      phase: "done",
      judgeRaw: { text: String(text).slice(0, 4000) },
    });

    send(res, 200, { ok: true, ready: true, judge: normalized });
  } catch (e) {
    send(res, 500, { error: "judge に失敗しました。", detail: String(e?.message || e) });
  }
};

