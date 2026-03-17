function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("JSONが不正です。"));
      }
    });
  });
}

function requirePost(req, res) {
  if (req.method !== "POST") {
    send(res, 405, { error: "POSTのみ対応です。" });
    return false;
  }
  return true;
}

module.exports = { send, readJson, requirePost };

