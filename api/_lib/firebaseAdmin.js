const admin = require("firebase-admin");

function getServiceAccount() {
  // 推奨: Vercel env で JSON をそのまま入れる
  // - FIREBASE_SERVICE_ACCOUNT_JSON
  // 代替: base64
  // - FIREBASE_SERVICE_ACCOUNT_B64
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON がJSONとして不正です。");
    }
  }

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    try {
      const json = Buffer.from(b64, "base64").toString("utf8");
      return JSON.parse(json);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 がbase64/JSONとして不正です。");
    }
  }

  throw new Error(
    "Firebase Admin 初期化用の環境変数がありません。FIREBASE_SERVICE_ACCOUNT_JSON または FIREBASE_SERVICE_ACCOUNT_B64 を設定してください。"
  );
}

function getAdminApp() {
  if (admin.apps?.length) return admin.app();
  const sa = getServiceAccount();
  return admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
}

function getDb() {
  getAdminApp();
  return admin.firestore();
}

module.exports = { admin, getAdminApp, getDb };

