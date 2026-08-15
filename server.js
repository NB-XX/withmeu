const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const Database = require("better-sqlite3");

const PORT = 3456;
const DB_PATH = path.join(__dirname, "data.db");
const JSON_DB_PATH = path.join(__dirname, "db.json");
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

// ====== 默认认证（从 config.json 读取）======
const CONFIG_PATH = path.join(__dirname, "config.json");
let DEFAULT_CONFIG = { authorization: "", refreshToken: "" };
try {
  DEFAULT_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  console.log("Loaded auth from config.json");
} catch (e) {
  console.warn("config.json not found or invalid, using empty auth. Copy config.example.json to config.json and fill in your token.");
}

// ====== 站点访问密码（环境变量 ACCESS_PASSWORD，留空则开放访问）======
const ACCESS_PASSWORD = (process.env.ACCESS_PASSWORD || "").trim();

// ====== JWT Token 管理 ======

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch { return null; }
}

function isTokenExpired(token) {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return true;
  // 提前 60 秒过期，避免边界情况
  return (Date.now() / 1000) >= (payload.exp - 60);
}

async function refreshAuthToken() {
  if (!DEFAULT_CONFIG.refreshToken) {
    console.warn("No refreshToken configured, cannot refresh");
    return false;
  }
  console.log("Token expired, refreshing...");
  try {
    const result = await httpPost(
      "app.withfan.co", 6372, "/api/v3/user/token/refresh",
      "refreshToken=" + encodeURIComponent(DEFAULT_CONFIG.refreshToken),
      { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }
    );
    if (result.status === 200 && result.data.token) {
      DEFAULT_CONFIG.authorization = result.data.token;
      DEFAULT_CONFIG.refreshToken = result.data.refreshToken;
      // Persist to config.json
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
      const exp = decodeJwtPayload(result.data.token)?.exp;
      console.log("Token refreshed, new expiry:", exp ? new Date(exp * 1000).toISOString() : "unknown");
      return true;
    } else {
      console.error("Token refresh returned status:", result.status, result.data);
      return false;
    }
  } catch (e) {
    console.error("Token refresh failed:", e.message);
    return false;
  }
}

async function ensureValidAuth() {
  if (!isTokenExpired(DEFAULT_CONFIG.authorization)) return DEFAULT_CONFIG.authorization;
  await refreshAuthToken();
  return DEFAULT_CONFIG.authorization;
}

const ARTISTS = [
  { id: "12289", name: "ZHAN", kr: "지한" },
  { id: "12290", name: "IVI", kr: "이비" },
  { id: "12291", name: "SUA", kr: "수아" },
  { id: "12292", name: "RITZ", kr: "리츠" },
  { id: "12293", name: "CHOEUN", kr: "최은" },
  { id: "14433", name: "KANA", kr: "카나" },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// ========== SQLite Database ==========

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("cache_size = -8000"); // 8MB cache

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    kr TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    last_sync_at TEXT NOT NULL DEFAULT '2026-01-01 00:00:00.000',
    last_fetched TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    message_id INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    content TEXT,
    type TEXT,
    created_at TEXT,
    is_delete TEXT,
    deleted_at TEXT,
    message_reply_id INTEGER,
    reply_content TEXT,
    nickname TEXT,
    profile_image TEXT,
    PRIMARY KEY (profile_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS translations (
    message_id INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    translation TEXT,
    fan_translation TEXT,
    PRIMARY KEY (profile_id, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_msg_profile_created ON messages(profile_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trans_profile ON translations(profile_id);
`);

// Prepared statements
const stmts = {
  // profiles
  upsertProfile: db.prepare(`INSERT OR REPLACE INTO profiles (id, name, kr, avatar, last_sync_at, last_fetched) VALUES (?, ?, ?, ?, ?, ?)`),
  getProfile: db.prepare(`SELECT * FROM profiles WHERE id = ?`),
  getProfiles: db.prepare(`SELECT * FROM profiles`),

  // messages
  upsertMessage: db.prepare(`INSERT OR REPLACE INTO messages (message_id, profile_id, content, type, created_at, is_delete, deleted_at, message_reply_id, reply_content, nickname, profile_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getMessages: db.prepare(`SELECT * FROM messages WHERE profile_id = ? ORDER BY created_at DESC`),
  getMessageCount: db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE profile_id = ?`),
  deleteMessagesByProfile: db.prepare(`DELETE FROM messages WHERE profile_id = ?`),
  searchMessages: db.prepare(`SELECT m.*, t.translation, t.fan_translation FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE m.profile_id = ? AND (m.content LIKE ? OR m.reply_content LIKE ? OR t.translation LIKE ? OR t.fan_translation LIKE ?) ORDER BY m.created_at DESC`),

  // translations
  upsertTranslation: db.prepare(`INSERT OR REPLACE INTO translations (message_id, profile_id, translation, fan_translation) VALUES (?, ?, ?, ?)`),
  getTranslation: db.prepare(`SELECT * FROM translations WHERE profile_id = ? AND message_id = ?`),
  deleteTranslationsByProfile: db.prepare(`DELETE FROM translations WHERE profile_id = ?`),
};

// ========== Migrate from old db.json ==========

function migrateJson() {
  if (!fs.existsSync(JSON_DB_PATH)) return;
  try {
    const old = JSON.parse(fs.readFileSync(JSON_DB_PATH, "utf-8"));
    const profiles = old.profiles || {};

    const tx = db.transaction(() => {
      for (const [pid, p] of Object.entries(profiles)) {
        const artist = ARTISTS.find((a) => a.id === pid);
        stmts.upsertProfile.run(
          pid, p.name || artist?.name || pid, p.kr || artist?.kr || "",
          p.avatar || "", p.lastSyncAt || "2026-01-01 00:00:00.000",
          p.lastFetched || null
        );
        for (const msg of Object.values(p.messages || {})) {
          const content = normalizeContent(msg.content, msg.type);
          const replyContent = normalizeContent(msg.replyContent, "text");
          stmts.upsertMessage.run(
            msg.messageId, pid, content, msg.type || "text",
            msg.createdAt || null, msg.isDelete || "false", msg.deletedAt || null,
            msg.messageReplyId || -1, replyContent,
            msg.nickname || null, msg.profileImage || null
          );
        }
        for (const [mid, txt] of Object.entries(p.translations || {})) {
          const ft = (p.fanTranslations || {})[mid] || null;
          stmts.upsertTranslation.run(parseInt(mid), pid, txt, ft);
        }
      }
    });
    tx();

    // Rename old file as backup
    fs.renameSync(JSON_DB_PATH, JSON_DB_PATH + ".bak");
    console.log("📦 Migrated db.json → SQLite");
  } catch (e) {
    console.error("Migration failed:", e.message);
  }
}

migrateJson();

// ========== HTTP helpers ==========

function httpGet(hostname, port, path, headers) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, port, path, method: "GET", headers };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, data: body }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

function httpPost(hostname, port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, port, path, method: "POST", headers };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, data: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

async function getAuth(req) {
  const token = req.headers["x-withfan-auth"] || DEFAULT_CONFIG.authorization;
  // Validate and refresh if needed
  const validToken = req.headers["x-withfan-auth"]
    ? token  // User-provided token: use as-is
    : await ensureValidAuth();  // Server token: check and refresh
  return { authorization: validToken };
}

// ========== withFan API ==========

async function fetchFromWithFan(profileId, lastSyncAt, auth) {
  const cursor = encodeURIComponent("{}");
  const path = `/api/v3/message?cursor=${cursor}&lastSyncAt=${encodeURIComponent(lastSyncAt)}&profileId=${profileId}`;
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    Authorization: auth.authorization,
  };
  const result = await httpGet("app.withfan.co", 6372, path, headers);
  if (result.status !== 200) {
    throw new Error(`withFan API returned ${result.status}`);
  }
  const messages = (result.data.message || []).filter((m) => m.isDelete === "false");
  return { messages, hasMore: result.data.hasMore, lastSyncAt: result.data.lastSyncAt, cursor: result.data.cursor, etag: result.headers.etag || "" };
}

// ========== Translation API ==========

// withFan changed (2026-08-15) `content`/`replyContent` and translate `content`
// from a plain string into an array of content-block objects, e.g.
// [{"text":"안녕"}], [{"voice":"https://...mp4"}], [{"image":"...png"}].
// Older messages still return a plain string. Normalize both back to a plain
// string (text -> joined blocks; voice/image -> the media URL).
function blockText(b) {
  if (!b || typeof b !== "object") return null;
  for (const k of ["text", "voice", "image", "src", "url"]) {
    const v = b[k];
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return null;
}
function normalizeContent(content, type) {
  if (content == null) return null;
  if (typeof content === "string") {
    const s = content.trim();
    return s === "" || s === "null" ? null : content;
  }
  const blocks = Array.isArray(content) ? content : [content];
  const isMedia = type === "voice" || type === "image";
  const parts = blocks.map(blockText).filter(Boolean);
  const joined = parts.join(isMedia ? "" : "\n").trim();
  return joined || null;
}

async function translateMessage(messageId, content, auth) {
  const path = `/api/v4/message/translate?id=${messageId}&languageId=4&type=message`;
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
    "Authorization": auth.authorization,
  };
  try {
    const result = await httpGet("app.withfan.co", 6372, path, headers);
    const c = normalizeContent(result.data?.content, "text");
    if (result.status === 200 && c) return c;
  } catch (e) {}
  return null;
}

async function translateFanReply(replyId, content, auth) {
  // content is the already-normalized reply string here.
  const c = normalizeContent(content, "text") || "";
  if (c && !/[가-힣]/.test(c)) return c;
  const path = `/api/v4/message/translate?id=${replyId}&languageId=4&type=messageReply`;
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
    "Authorization": auth.authorization,
  };
  try {
    const result = await httpGet("app.withfan.co", 6372, path, headers);
    const got = normalizeContent(result.data?.content, "text");
    if (result.status === 200 && got) return got;
  } catch (e) {}
  return null;
}

async function translateBatch(msgMap, auth, translator, concurrency = 3) {
  const results = {};
  const entries = Object.entries(msgMap);
  const queue = [...entries];
  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push((async () => { while (queue.length > 0) { const [id, content] = queue.shift(); results[id] = await translator(id, content, auth); } })());
  }
  await Promise.all(workers);
  return results;
}

// ========== Sync profile ==========

async function syncProfile(profileId, auth) {
  // Ensure profile row exists
  let profile = stmts.getProfile.get(profileId);
  if (!profile) {
    const artist = ARTISTS.find((a) => a.id === profileId);
    stmts.upsertProfile.run(profileId, artist?.name || profileId, artist?.kr || "", "", "2026-01-01 00:00:00.000", null);
    profile = stmts.getProfile.get(profileId);
  }

  const lastSyncAt = profile.last_sync_at || "2026-01-01 00:00:00.000";
  console.log(`  🔄 Fetching ${profile.name} since ${lastSyncAt}...`);

  const result = await fetchFromWithFan(profileId, lastSyncAt, auth);

  // Insert messages (SKIP on conflict — keep existing)
  const insertMsg = db.prepare(`INSERT OR IGNORE INTO messages (message_id, profile_id, content, type, created_at, is_delete, deleted_at, message_reply_id, reply_content, nickname, profile_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let newCount = 0;
  const tx = db.transaction(() => {
    for (const msg of result.messages) {
      // Normalize new array-of-blocks content format back to plain strings.
      msg.content = normalizeContent(msg.content, msg.type);
      msg.replyContent = normalizeContent(msg.replyContent, "text");
      const r = insertMsg.run(
        msg.messageId, profileId, msg.content, msg.type || "text",
        msg.createdAt || null, msg.isDelete || "false", msg.deletedAt || null,
        msg.messageReplyId || -1, msg.replyContent,
        msg.nickname || null, msg.profileImage || null
      );
      if (r.changes > 0) newCount++;
    }
  });
  tx();

  // Update profile info
  if (result.messages.length > 0) {
    const latest = result.messages.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    const newAvatar = latest.profileImage || profile.avatar;
    stmts.upsertProfile.run(profileId, profile.name, profile.kr, newAvatar, result.lastSyncAt || profile.last_sync_at, new Date().toISOString());
  } else {
    stmts.upsertProfile.run(profileId, profile.name, profile.kr, profile.avatar, result.lastSyncAt || profile.last_sync_at, new Date().toISOString());
  }

  // Translate new artist messages
  const untranslated = {};
  for (const msg of result.messages) {
    const t = stmts.getTranslation.get(profileId, msg.messageId);
    if (!t && msg.type === "text" && msg.content) {
      untranslated[String(msg.messageId)] = msg.content;
    }
  }

  if (Object.keys(untranslated).length > 0) {
    console.log(`  🌐 Translating ${Object.keys(untranslated).length} new artist messages...`);
    const trans = await translateBatch(untranslated, auth, translateMessage);
    const upsertT = db.prepare(`INSERT OR REPLACE INTO translations (message_id, profile_id, translation, fan_translation) VALUES (?, ?, ?, ?)`);
    const ttx = db.transaction(() => {
      for (const [id, txt] of Object.entries(trans)) {
        if (txt) {
          const existing = stmts.getTranslation.get(profileId, parseInt(id));
          upsertT.run(parseInt(id), profileId, txt, existing?.fan_translation || null);
        }
      }
    });
    ttx();
  }

  // Translate fan replies
  const untranslatedFan = {};
  for (const msg of result.messages) {
    const t = stmts.getTranslation.get(profileId, msg.messageId);
    if ((!t || !t.fan_translation) && msg.messageReplyId && msg.messageReplyId > 0 && msg.replyContent) {
      untranslatedFan[String(msg.messageReplyId)] = { msgKey: String(msg.messageId), content: msg.replyContent };
    }
  }

  if (Object.keys(untranslatedFan).length > 0) {
    console.log(`  🌐 Translating ${Object.keys(untranslatedFan).length} new fan replies...`);
    const fanMap = {};
    const fanKeyMap = {};
    for (const [replyId, { msgKey, content }] of Object.entries(untranslatedFan)) {
      fanMap[replyId] = content;
      fanKeyMap[replyId] = msgKey;
    }
    const trans = await translateBatch(fanMap, auth, translateFanReply);
    const upsertT = db.prepare(`INSERT OR REPLACE INTO translations (message_id, profile_id, translation, fan_translation) VALUES (?, ?, ?, ?)`);
    const ttx = db.transaction(() => {
      for (const [replyId, txt] of Object.entries(trans)) {
        if (txt) {
          const msgId = parseInt(fanKeyMap[replyId]);
          const existing = stmts.getTranslation.get(profileId, msgId);
          upsertT.run(msgId, profileId, existing?.translation || null, txt);
        }
      }
    });
    ttx();
  }

  const total = stmts.getMessageCount.get(profileId).cnt;
  console.log(`  ✅ ${profile.name}: ${newCount} new, ${total} total`);
  return getProfileData(profileId);
}

function getProfileData(profileId) {
  const p = stmts.getProfile.get(profileId);
  if (!p) return null;
  const total = stmts.getMessageCount.get(profileId).cnt;
  return {
    id: p.id, name: p.name, kr: p.kr, avatar: p.avatar,
    lastSyncAt: p.last_sync_at, lastFetched: p.last_fetched, total,
    messages: stmts.getMessages.all(profileId).map(m => ({
      messageId: m.message_id, profileId: m.profile_id, content: m.content,
      type: m.type, createdAt: m.created_at, isDelete: m.is_delete,
      deletedAt: m.deleted_at, messageReplyId: m.message_reply_id,
      replyContent: m.reply_content, nickname: m.nickname, profileImage: m.profile_image,
      translation: null, fanTranslation: null,
    })),
    translations: {},
    fanTranslations: {},
  };
}

// ========== HTTP Server ==========

function serveStatic(req, res) {
  const reqPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, "public", reqPath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not Found"); return; }
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (ext === ".html" || ext === ".js") headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    res.writeHead(200, headers);
    res.end(data);
  });
}

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

async function handleAPI(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // Access status — always public
  if (pathname === "/api/auth/status" && req.method === "GET") {
    jsonRes(res, { success: true, passwordRequired: !!ACCESS_PASSWORD });
    return;
  }

  // Access-password gate: when configured, all other API routes require it
  if (ACCESS_PASSWORD) {
    const provided = req.headers["x-access-password"] || "";
    if (provided !== ACCESS_PASSWORD) {
      jsonRes(res, { success: false, error: "password_required", passwordRequired: true }, 401);
      return;
    }
  }

  const auth = await getAuth(req);

  try {
    // GET /api/messages?profileId=X&limit=N&offset=N&dateFrom=...&dateTo=...&type=...&q=...
    if (pathname === "/api/messages" && req.method === "GET") {
      const profileId = query.profileId || "12289";
      const limit = Math.min(Math.max(parseInt(query.limit) || 50, 1), 200);
      const offset = Math.max(parseInt(query.offset) || 0, 0);

      // Ensure profile row exists
      if (!stmts.getProfile.get(profileId)) {
        const artist = ARTISTS.find(a => a.id === profileId);
        stmts.upsertProfile.run(profileId, artist?.name || profileId, artist?.kr || "", "", "2026-01-01 00:00:00.000", null);
      }

      const profile = stmts.getProfile.get(profileId);

      // Build dynamic WHERE with filters (plain ? for better-sqlite3)
      const conditions = ["m.profile_id = ?"];
      const binds = [profileId];

      if (query.dateFrom) {
        binds.push(query.dateFrom + " 00:00:00");
        conditions.push("m.created_at >= ?");
      }
      if (query.dateTo) {
        binds.push(query.dateTo + " 23:59:59");
        conditions.push("m.created_at <= ?");
      }
      if (query.type) {
        binds.push(query.type);
        conditions.push("m.type = ?");
      }
      if (query.q && query.q.trim()) {
        const like = "%" + query.q.trim() + "%";
        binds.push(like, like, like, like, like);
        conditions.push("(m.content LIKE ? OR m.reply_content LIKE ? OR m.nickname LIKE ? OR t.translation LIKE ? OR t.fan_translation LIKE ?)");
      }

      const where = conditions.join(" AND ");

      // Total unfiltered count
      const total = stmts.getMessageCount.get(profileId).cnt;

      // Filtered count
      const filteredTotal = db.prepare(
        "SELECT COUNT(*) AS cnt FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE " + where
      ).get(...binds).cnt;

      // Paginated messages with translation JOIN
      binds.push(limit, offset);
      const rows = db.prepare(
        "SELECT m.*, t.translation, t.fan_translation FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE " + where + " ORDER BY m.created_at DESC LIMIT ? OFFSET ?"
      ).all(...binds);

      const messages = rows.map(m => ({
        messageId: m.message_id, profileId: m.profile_id, content: m.content,
        type: m.type, createdAt: m.created_at, isDelete: m.is_delete,
        deletedAt: m.deleted_at, messageReplyId: m.message_reply_id,
        replyContent: m.reply_content, nickname: m.nickname, profileImage: m.profile_image,
        translation: m.translation || null,
        fanTranslation: m.fan_translation || null,
      }));

      jsonRes(res, {
        success: true,
        profile: {
          id: profile.id, name: profile.name, kr: profile.kr, avatar: profile.avatar,
          lastSyncAt: profile.last_sync_at, lastFetched: profile.last_fetched,
          total, filteredTotal,
        },
        messages,
        hasMore: offset + limit < filteredTotal,
      });
      return;
    }

    // GET /api/search?profileId=X&q=keyword&limit=N&offset=N
    if (pathname === "/api/search" && req.method === "GET") {
      const profileId = query.profileId || "12289";
      const q = query.q || "";
      if (!q || !q.trim()) { jsonRes(res, { success: true, messages: [], total: 0 }); return; }

      const limit = Math.min(Math.max(parseInt(query.limit) || 50, 1), 200);
      const offset = Math.max(parseInt(query.offset) || 0, 0);
      const like = `%${q.trim()}%`;

      const total = db.prepare(
        `SELECT COUNT(*) AS cnt FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE m.profile_id = ? AND (m.content LIKE ? OR m.reply_content LIKE ? OR m.nickname LIKE ? OR t.translation LIKE ? OR t.fan_translation LIKE ?)`
      ).get(profileId, like, like, like, like, like).cnt;

      const rows = db.prepare(
        `SELECT m.*, t.translation, t.fan_translation FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE m.profile_id = ? AND (m.content LIKE ? OR m.reply_content LIKE ? OR m.nickname LIKE ? OR t.translation LIKE ? OR t.fan_translation LIKE ?) ORDER BY m.created_at DESC LIMIT ? OFFSET ?`
      ).all(profileId, like, like, like, like, like, limit, offset);

      const messages = rows.map(m => ({
        messageId: m.message_id, profileId: m.profile_id, content: m.content,
        type: m.type, createdAt: m.created_at, isDelete: m.is_delete,
        deletedAt: m.deleted_at, messageReplyId: m.message_reply_id,
        replyContent: m.reply_content, nickname: m.nickname, profileImage: m.profile_image,
        translation: m.translation || null, fanTranslation: m.fan_translation || null,
      }));

      jsonRes(res, {
        success: true, query: q,
        total,
        messages,
        hasMore: offset + limit < total,
      });
      return;
    }

    // GET /api/stats?profileId=X&year=2026&month=7  (calendar: per-day + monthly type totals)
    if (pathname === "/api/stats" && req.method === "GET") {
      const profileId = query.profileId || "12289";
      const now = new Date();
      const year = Math.min(Math.max(parseInt(query.year) || now.getFullYear(), 2000), 2100);
      const month = Math.min(Math.max(parseInt(query.month) || (now.getMonth() + 1), 1), 12);
      const start = `${year}-${String(month).padStart(2, "0")}-01 00:00:00`;
      const nextMonth = month === 12
        ? `${year + 1}-01-01 00:00:00`
        : `${year}-${String(month + 1).padStart(2, "0")}-01 00:00:00`;

      const rows = db.prepare(
        "SELECT date(created_at) AS d, type, COUNT(*) AS cnt FROM messages WHERE profile_id = ? AND created_at >= ? AND created_at < ? GROUP BY d, type"
      ).all(profileId, start, nextMonth);

      const days = {};
      const summary = { total: 0, types: {} };
      for (const r of rows) {
        if (!days[r.d]) days[r.d] = { date: r.d, total: 0, types: {} };
        days[r.d].types[r.type] = (days[r.d].types[r.type] || 0) + r.cnt;
        days[r.d].total += r.cnt;
        summary.types[r.type] = (summary.types[r.type] || 0) + r.cnt;
        summary.total += r.cnt;
      }

      const profile = stmts.getProfile.get(profileId);
      jsonRes(res, {
        success: true,
        profile: profile ? { id: profile.id, name: profile.name, kr: profile.kr, avatar: profile.avatar } : null,
        range: { year, month },
        summary,
        days: Object.values(days),
      });
      return;
    }

    // GET /api/profiles
    if (pathname === "/api/profiles" && req.method === "GET") {
      const profiles = ARTISTS.map(a => {
        const p = stmts.getProfile.get(a.id);
        const cnt = p ? stmts.getMessageCount.get(a.id).cnt : 0;
        return {
          id: a.id, name: a.name, kr: a.kr,
          avatar: p ? p.avatar : "",
          messageCount: cnt,
          lastFetched: p ? p.last_fetched : null,
          lastSyncAt: p ? p.last_sync_at : null,
        };
      });
      jsonRes(res, { success: true, profiles });
      return;
    }

    if (pathname === "/api/login" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const result = await httpPost("app.withfan.co", 6372, "/api/v3/user/login", body, {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        });
        if (result.status === 200 && result.data && result.data.token) {
          jsonRes(res, { success: true, token: result.data.token, refreshToken: result.data.refreshToken || "" });
        } else {
          const msg = (result.data && result.data.message) ? result.data.message : ("Login failed (status " + result.status + ")");
          jsonRes(res, { error: msg }, 401);
        }
      } catch (e) {
        jsonRes(res, { error: "Login request failed: " + e.message }, 502);
      }
      return;
    }

    jsonRes(res, { error: "Unknown API endpoint" }, 404);
  } catch (err) {
    console.error("API Error:", err.message);
    jsonRes(res, { error: err.message }, 500);
  }
}

function handleCors(req, res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "X-Access-Password, X-WithFan-Auth, Content-Type",
  });
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return handleCors(req, res);
  if (req.url.startsWith("/api/")) return handleAPI(req, res);
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`✨ withMeu → http://localhost:${PORT}`);
  console.log(`   📂 SQLite: ${DB_PATH}`);
  console.log(`   🔄 Auto-refresh: every ${REFRESH_INTERVAL_MS / 60000} min`);

  // Log initial token status
  const payload = decodeJwtPayload(DEFAULT_CONFIG.authorization);
  if (payload && payload.exp) {
    console.log(`   🔑 Token expiry: ${new Date(payload.exp * 1000).toISOString()}`);
    if (isTokenExpired(DEFAULT_CONFIG.authorization)) {
      console.log("   ⚠️  Token is already expired, will refresh on first API call");
    }
  }
  if (DEFAULT_CONFIG.refreshToken) {
    const refPayload = decodeJwtPayload(DEFAULT_CONFIG.refreshToken);
    if (refPayload && refPayload.exp) {
      console.log(`   🔑 RefreshToken expiry: ${new Date(refPayload.exp * 1000).toISOString()}`);
    }
  }

  // Periodic token check (every 5 minutes) — refreshes proactively if close to expiry
  setInterval(async () => {
    if (isTokenExpired(DEFAULT_CONFIG.authorization)) {
      console.log("Periodic check: token expired, refreshing...");
      await refreshAuthToken();
    }
  }, 5 * 60 * 1000);
});
