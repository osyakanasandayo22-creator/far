const { getDb, admin } = require("./_lib/firebaseAdmin");
const { send, readJson, requirePost } = require("./_lib/http");

function normalizeName(name) {
  if (typeof name !== "string") return "ユーザー";
  const t = name.trim().slice(0, 20);
  return t || "ユーザー";
}

function makePrompt() {
  const prompts = [
    "「春」を遠い言葉で言うと？",
    "「雨上がり」を遠い言葉で言うと？",
    "「初恋」を遠い言葉で言うと？",
    "「駅のホーム」を遠い言葉で言うと？",
    "「さよなら」を遠い言葉で言うと？",
  ];
  return prompts[Math.floor(Math.random() * prompts.length)];
}

module.exports = async (req, res) => {
  if (!requirePost(req, res)) return;

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    send(res, 400, { error: e.message });
    return;
  }

  const uid = typeof body.uid === "string" ? body.uid : "";
  if (!uid) {
    send(res, 400, { error: "uid が必要です。" });
    return;
  }
  const displayName = normalizeName(body.displayName);

  const db = getDb();
  const queueCol = db.collection("queue");
  const matchesCol = db.collection("matches");

  try {
    const result = await db.runTransaction(async (tx) => {
      const meRef = queueCol.doc(uid);

      // 自分を待機状態に
      tx.set(
        meRef,
        {
          uid,
          displayName,
          state: "waiting",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // 既にmatchIdが付いてる場合はそれを返す（リトライ耐性）
      const meSnap = await tx.get(meRef);
      const me = meSnap.data() || {};
      if (me.matchId) return { waiting: false, matchId: me.matchId };

      // 古い待機者を1人拾う（自分以外）
      const qSnap = await tx.get(
        queueCol.where("state", "==", "waiting").orderBy("createdAt", "asc").limit(10)
      );

      const oppDoc = qSnap.docs.find((d) => d.id !== uid);
      if (!oppDoc) return { waiting: true };

      const opp = oppDoc.data() || {};
      const oppUid = opp.uid;
      if (typeof oppUid !== "string" || !oppUid) return { waiting: true };

      const matchRef = matchesCol.doc();
      const prompt = makePrompt();

      tx.set(matchRef, {
        players: [uid, oppUid],
        playerNames: {
          [uid]: displayName,
          [oppUid]: normalizeName(opp.displayName),
        },
        prompt,
        phase: "answer",
        answers: {},
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 両者にmatchIdを通知
      tx.set(meRef, { state: "matched", matchId: matchRef.id }, { merge: true });
      tx.set(queueCol.doc(oppUid), { state: "matched", matchId: matchRef.id }, { merge: true });

      return { waiting: false, matchId: matchRef.id };
    });

    send(res, 200, { ok: true, ...result });
  } catch (e) {
    send(res, 500, { error: "joinQueue に失敗しました。", detail: String(e?.message || e) });
  }
};

