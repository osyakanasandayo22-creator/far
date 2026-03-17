const { getDb } = require("./_lib/firebaseAdmin");
const { send, readJson, requirePost } = require("./_lib/http");

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

  const db = getDb();
  try {
    await db.collection("queue").doc(uid).delete();
    send(res, 200, { ok: true });
  } catch (e) {
    send(res, 500, { error: "leaveQueue に失敗しました。", detail: String(e?.message || e) });
  }
};

