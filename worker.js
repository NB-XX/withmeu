// withMeu — Cloudflare Worker
// API proxy + D1 storage + scheduled sync

import config from "./config.json" with { type: "json" };

const ARTISTS = [
  { id: "12289", name: "ZHAN", kr: "지한" },
  { id: "12290", name: "IVI", kr: "이비" },
  { id: "12291", name: "SUA", kr: "수아" },
  { id: "12292", name: "RITZ", kr: "리츠" },
  { id: "12293", name: "CHOEUN", kr: "최은" },
  { id: "14433", name: "KANA", kr: "카나" },
];

// ====== Token management (mutable in-memory, persisted to D1) ======

let CURRENT_AUTH = config.authorization;
let CURRENT_REFRESH = config.refreshToken || "";

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // Base64url-decode the payload (second part)
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch { return null; }
}

function isTokenExpired(token) {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return true;
  // Expire 60 seconds early to avoid edge cases
  return (Date.now() / 1000) >= (payload.exp - 60);
}

// Load tokens from D1 (persisted from previous worker runs)
async function loadTokensFromD1(env) {
  try {
    const authRow = await env.DB.prepare(
      "SELECT value FROM tokens WHERE key = 'authorization'"
    ).first();
    if (authRow && authRow.value) CURRENT_AUTH = authRow.value;

    const refRow = await env.DB.prepare(
      "SELECT value FROM tokens WHERE key = 'refreshToken'"
    ).first();
    if (refRow && refRow.value) CURRENT_REFRESH = refRow.value;
  } catch (e) {
    // Table may not exist yet; fall through to config defaults
  }
}

// Persist tokens to D1 so they survive cold starts
async function saveTokensToD1(env) {
  try {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO tokens (key, value) VALUES ('authorization', ?1)"
    ).bind(CURRENT_AUTH).run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO tokens (key, value) VALUES ('refreshToken', ?1)"
    ).bind(CURRENT_REFRESH).run();
  } catch (e) {
    console.error("Failed to save tokens to D1:", e.message);
  }
}

// Ensure we have a valid (non-expired) auth token, refreshing if needed
async function ensureValidAuth(env) {
  // Load any previously-refreshed tokens from D1
  await loadTokensFromD1(env);

  if (!isTokenExpired(CURRENT_AUTH)) return CURRENT_AUTH;

  // Token is expired — try to refresh
  if (!CURRENT_REFRESH) {
    console.warn("No refreshToken available, token will remain expired");
    return CURRENT_AUTH;
  }

  console.log("Token expired, refreshing...");
  try {
    const resp = await fetch("http://app.withfan.co:6372/api/v3/user/token/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "refreshToken=" + encodeURIComponent(CURRENT_REFRESH),
    });

    if (resp.status === 200) {
      const data = await resp.json();
      CURRENT_AUTH = data.token;
      CURRENT_REFRESH = data.refreshToken;
      await saveTokensToD1(env);
      console.log("Token refreshed successfully, new expiry:", new Date(decodeJwtPayload(CURRENT_AUTH).exp * 1000).toISOString());
      return CURRENT_AUTH;
    } else {
      console.error("Token refresh returned status:", resp.status);
    }
  } catch (e) {
    console.error("Token refresh failed:", e.message);
  }

  // Return whatever we have (may still be expired — API calls will fail)
  return CURRENT_AUTH;
}

// ====== Helpers ======

// ========== Helpers ==========

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function getAuth(request) {
  return request.headers.get("X-WithFan-Auth") || CURRENT_AUTH;
}

// ========== withFan API proxy ==========

async function wfFetch(path, auth) {
  const resp = await fetch(`http://app.withfan.co:6372${path}`, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: auth,
    },
  });
  const data = await resp.json();
  return { status: resp.status, data };
}

// withFan's translate API (languageId=4 -> Simplified Chinese) returns an empty
// `content` when the source text isn't Korean (e.g. CN fans writing in Chinese).
// Such replies never get a translation, so they pile up at the head of the
// retry queue (which is ordered newest-first) and block older Korean replies
// from ever being retried. Treat any reply with no Hangul as already in the
// target language: the original text IS the result, no API call needed.
function hasHangul(text) {
  return /[가-힣]/.test(text || "");
}

function resolveFanTranslation(content, apiContent) {
  if (apiContent && apiContent.trim()) return apiContent.trim();
  const c = (content || "").trim();
  if (!c) return null;
  // No Korean to translate from -> keep the original (covers CN fans, emoji, etc.)
  if (!hasHangul(c)) return c;
  return null;
}

// ========== API handlers ==========

async function handleProfiles(env) {
  const rows = await env.DB.prepare("SELECT id, name, kr, avatar, last_sync_at, last_fetched FROM profiles").all();
  const msgCounts = await env.DB.prepare("SELECT profile_id, COUNT(*) AS cnt FROM messages GROUP BY profile_id").all();

  const countMap = {};
  for (const r of msgCounts.results) countMap[r.profile_id] = r.cnt;

  const profiles = ARTISTS.map((a) => {
    const p = rows.results.find((r) => r.id === a.id);
    return {
      id: a.id, name: a.name, kr: a.kr,
      avatar: p ? p.avatar : "",
      messageCount: countMap[a.id] || 0,
      lastFetched: p ? p.last_fetched : null,
      lastSyncAt: p ? p.last_sync_at : null,
    };
  });

  return json({ success: true, profiles });
}

async function handleMessages(env, profileId, auth, params) {
  // Ensure profile row
  await env.DB.prepare("INSERT OR IGNORE INTO profiles (id, name, kr, avatar, last_sync_at) VALUES (?1, ?2, ?3, '', '2026-01-01 00:00:00.000')")
    .bind(profileId, ARTISTS.find((a) => a.id === profileId)?.name || profileId, ARTISTS.find((a) => a.id === profileId)?.kr || "")
    .run();

  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(profileId).first();

  const limit = Math.min(Math.max(parseInt(params.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(params.offset) || 0, 0);

  // Build WHERE clauses for filters
  const conditions = ["m.profile_id = ?1"];
  const bindArr = [profileId];

  if (params.dateFrom) {
    bindArr.push(params.dateFrom + " 00:00:00");
    conditions.push("m.created_at >= ?" + bindArr.length);
  }
  if (params.dateTo) {
    bindArr.push(params.dateTo + " 23:59:59");
    conditions.push("m.created_at <= ?" + bindArr.length);
  }
  if (params.type) {
    bindArr.push(params.type);
    conditions.push("m.type = ?" + bindArr.length);
  }
  if (params.q && params.q.trim()) {
    const like = "%" + params.q.trim() + "%";
    bindArr.push(like, like, like, like);
    const n = bindArr.length;
    conditions.push("(m.content LIKE ?" + (n - 3) + " OR m.reply_content LIKE ?" + (n - 2) + " OR m.nickname LIKE ?" + (n - 1) + " OR t.translation LIKE ?" + n + " OR t.fan_translation LIKE ?" + n + ")");
  }

  const where = conditions.join(" AND ");

  // Total unfiltered count
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM messages WHERE profile_id = ?1").bind(profileId).first();
  const total = totalRow ? totalRow.cnt : 0;

  // Filtered count
  const filteredRow = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE " + where
  ).bind(...bindArr).first();
  const filteredTotal = filteredRow ? filteredRow.cnt : 0;

  // Paginated messages with translation JOIN
  bindArr.push(limit, offset);
  const rows = await env.DB.prepare(
    "SELECT m.*, t.translation, t.fan_translation FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE " + where + " ORDER BY m.created_at DESC LIMIT ?" + (bindArr.length - 1) + " OFFSET ?" + bindArr.length
  ).bind(...bindArr).all();

  const messages = rows.results.map((m) => ({
    messageId: m.message_id, profileId: m.profile_id, content: m.content,
    type: m.type, createdAt: m.created_at, isDelete: m.is_delete,
    deletedAt: m.deleted_at, messageReplyId: m.message_reply_id,
    replyContent: m.reply_content, nickname: m.nickname, profileImage: m.profile_image,
    translation: m.translation || null,
    fanTranslation: m.fan_translation || null,
  }));

  return json({
    success: true,
    profile: {
      id: profile.id, name: profile.name, kr: profile.kr, avatar: profile.avatar,
      lastSyncAt: profile.last_sync_at, lastFetched: profile.last_fetched,
      total, filteredTotal,
    },
    messages,
    hasMore: offset + limit < filteredTotal,
  });
}


async function handleSearch(env, profileId, q, params) {
  if (!q || !q.trim()) return json({ success: true, messages: [], total: 0 });

  const limit = Math.min(Math.max(parseInt(params.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(params.offset) || 0, 0);
  const like = `%${q.trim()}%`;

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE m.profile_id = ?1 AND (m.content LIKE ?2 OR m.reply_content LIKE ?3 OR m.nickname LIKE ?4 OR t.translation LIKE ?5 OR t.fan_translation LIKE ?6)`
  ).bind(profileId, like, like, like, like, like).first();

  const rows = await env.DB.prepare(
    `SELECT m.*, t.translation, t.fan_translation FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE m.profile_id = ?1 AND (m.content LIKE ?2 OR m.reply_content LIKE ?3 OR m.nickname LIKE ?4 OR t.translation LIKE ?5 OR t.fan_translation LIKE ?6) ORDER BY m.created_at DESC LIMIT ?7 OFFSET ?8`
  ).bind(profileId, like, like, like, like, like, limit, offset).all();

  const messages = rows.results.map((m) => ({
    messageId: m.message_id, profileId: m.profile_id, content: m.content,
    type: m.type, createdAt: m.created_at, isDelete: m.is_delete,
    deletedAt: m.deleted_at, messageReplyId: m.message_reply_id,
    replyContent: m.reply_content, nickname: m.nickname, profileImage: m.profile_image,
    translation: m.translation || null, fanTranslation: m.fan_translation || null,
  }));

  return json({
    success: true, query: q,
    total: countRow ? countRow.cnt : 0,
    messages,
    hasMore: offset + limit < (countRow ? countRow.cnt : 0),
  });
}

// ========== Sync ==========

async function handleStats(env, profileId, params) {
  const now = new Date();
  const year = Math.min(Math.max(parseInt(params.year) || now.getUTCFullYear(), 2000), 2100);
  const month = Math.min(Math.max(parseInt(params.month) || (now.getUTCMonth() + 1), 1), 12);
  const start = `${year}-${String(month).padStart(2, "0")}-01 00:00:00`;
  const nextMonth = month === 12
    ? `${year + 1}-01-01 00:00:00`
    : `${year}-${String(month + 1).padStart(2, "0")}-01 00:00:00`;

  const rows = await env.DB.prepare(
    "SELECT date(created_at) AS d, type, COUNT(*) AS cnt FROM messages WHERE profile_id = ?1 AND created_at >= ?2 AND created_at < ?3 GROUP BY d, type"
  ).bind(profileId, start, nextMonth).all();

  const days = {};
  const summary = { total: 0, types: {} };
  for (const r of rows.results) {
    if (!days[r.d]) days[r.d] = { date: r.d, total: 0, types: {} };
    days[r.d].types[r.type] = (days[r.d].types[r.type] || 0) + r.cnt;
    days[r.d].total += r.cnt;
    summary.types[r.type] = (summary.types[r.type] || 0) + r.cnt;
    summary.total += r.cnt;
  }

  const profile = await env.DB.prepare("SELECT id, name, kr, avatar FROM profiles WHERE id = ?1").bind(profileId).first();
  return json({
    success: true,
    profile: profile || null,
    range: { year, month },
    summary,
    days: Object.values(days),
  });
}

async function syncProfile(env, profileId, auth) {
  const profile = await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(profileId).first();
  if (!profile) return;

  const lastSyncAt = profile.last_sync_at || "2026-01-01 00:00:00.000";
  const cursor = encodeURIComponent("{}");
  const path = `/api/v3/message?cursor=${cursor}&lastSyncAt=${encodeURIComponent(lastSyncAt)}&profileId=${profileId}`;

  let result;
  try {
    result = await wfFetch(path, auth);
  } catch (e) {
    console.error(`Fetch failed for ${profileId}:`, e.message);
    return;
  }

  if (result.status !== 200 || !result.data.message) {
    // Still try to fill missing translations even if fetch fails
    await retryMissingTranslations(env, profileId, auth);
    return;
  }

  const messages = (result.data.message || []).filter((m) => m.isDelete === "false");
  if (messages.length > 0) {

  // Batch insert new messages
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO messages (message_id, profile_id, content, type, created_at, is_delete, deleted_at, message_reply_id, reply_content, nickname, profile_image) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
  );

  const batch = [];
  for (const msg of messages) {
    batch.push(stmt.bind(
      msg.messageId, profileId, msg.content || null, msg.type || "text",
      msg.createdAt || null, msg.isDelete || "false", msg.deletedAt || null,
      msg.messageReplyId || -1, msg.replyContent || null,
      msg.nickname || null, msg.profileImage || null
    ));
  }

  if (batch.length > 0) await env.DB.batch(batch);

  // Update profile
  const latest = messages.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
  const newAvatar = latest.profileImage || profile.avatar;
  const newSyncAt = result.data.lastSyncAt || profile.last_sync_at;

  await env.DB.prepare("UPDATE profiles SET avatar = ?1, last_sync_at = ?2, last_fetched = ?3 WHERE id = ?4")
    .bind(newAvatar, newSyncAt, new Date().toISOString(), profileId).run();

  // Translate new messages
  for (const msg of messages) {
    const t = await env.DB.prepare("SELECT translation FROM translations WHERE profile_id = ?1 AND message_id = ?2")
      .bind(profileId, msg.messageId).first();
    if ((!t || !t.translation) && msg.type === "text" && msg.content) {
      // Try translate (fire-and-forget per message)
      try {
        const tr = await wfFetch(`/api/v4/message/translate?id=${msg.messageId}&languageId=4&type=message`, auth);
        if (tr.status === 200 && tr.data.content && tr.data.content.trim()) {
          await env.DB.prepare("INSERT OR REPLACE INTO translations (message_id, profile_id, translation, fan_translation) VALUES (?1, ?2, ?3, '')")
            .bind(msg.messageId, profileId, tr.data.content).run();
        }
      } catch (e) { /* skip */ }
    }
    // Fan reply translation
    if (msg.messageReplyId && msg.messageReplyId > 0 && msg.replyContent && msg.replyContent !== "null" && msg.replyContent.trim()) {
      const ft = await env.DB.prepare("SELECT fan_translation FROM translations WHERE profile_id = ?1 AND message_id = ?2")
        .bind(profileId, msg.messageId).first();
      if (!ft || !ft.fan_translation) {
        const resolved = resolveFanTranslation(msg.replyContent, null);
        if (!resolved) {
          try {
            const tr = await wfFetch(`/api/v4/message/translate?id=${msg.messageReplyId}&languageId=4&type=messageReply`, auth);
            if (tr.status === 200) {
              const got = resolveFanTranslation(msg.replyContent, tr.data.content);
              if (got) {
                const existing = await env.DB.prepare("SELECT translation FROM translations WHERE profile_id = ?1 AND message_id = ?2")
                  .bind(profileId, msg.messageId).first();
                await env.DB.prepare("INSERT OR REPLACE INTO translations (message_id, profile_id, translation, fan_translation) VALUES (?1, ?2, ?3, ?4)")
                  .bind(msg.messageId, profileId, existing?.translation || null, got).run();
              }
            }
          } catch (e) { /* skip */ }
        } else {
          // Already in target language (e.g. CN fan writing Chinese) -> store as-is
          const existing = await env.DB.prepare("SELECT translation FROM translations WHERE profile_id = ?1 AND message_id = ?2")
            .bind(profileId, msg.messageId).first();
          await env.DB.prepare("INSERT OR REPLACE INTO translations (message_id, profile_id, translation, fan_translation) VALUES (?1, ?2, ?3, ?4)")
            .bind(msg.messageId, profileId, existing?.translation || null, resolved).run();
        }
      }
    }
  }
  } // close if (messages.length > 0)

  await retryMissingTranslations(env, profileId, auth);

  // Always update last_fetched so frontend knows sync is alive
  await env.DB.prepare("UPDATE profiles SET last_fetched = ?1 WHERE id = ?2")
    .bind(new Date().toISOString(), profileId).run();

  console.log("Synced " + profile.name + ": " + messages.length + " new, retried translations");
}

async function retryMissingTranslations(env, profileId, auth) {
  // Retry missing message translations (up to 20 per run)
  try {
    const untranslated = await env.DB.prepare(
      "SELECT m.message_id FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE m.profile_id = ?1 AND m.type = 'text' AND m.content IS NOT NULL AND m.content != '' AND (t.translation IS NULL OR t.translation = '') ORDER BY m.created_at DESC LIMIT 20"
    ).bind(profileId).all();
    for (const row of untranslated.results) {
      try {
        const tr = await wfFetch("/api/v4/message/translate?id=" + row.message_id + "&languageId=4&type=message", auth);
        if (tr.status === 200 && tr.data.content && tr.data.content.trim()) {
          const existing = await env.DB.prepare("SELECT fan_translation FROM translations WHERE profile_id = ?1 AND message_id = ?2")
            .bind(profileId, row.message_id).first();
          await env.DB.prepare("INSERT OR REPLACE INTO translations (message_id, profile_id, translation, fan_translation) VALUES (?1, ?2, ?3, ?4)")
            .bind(row.message_id, profileId, tr.data.content, existing?.fan_translation || null).run();
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip */ }

  // Retry missing fan translations (up to 50 per run)
  try {
    const untranslatedFan = await env.DB.prepare(
      "SELECT m.message_id, m.message_reply_id, m.reply_content FROM messages m LEFT JOIN translations t ON t.profile_id = m.profile_id AND t.message_id = m.message_id WHERE m.profile_id = ?1 AND m.message_reply_id > 0 AND m.reply_content IS NOT NULL AND m.reply_content != '' AND m.reply_content != 'null' AND (t.fan_translation IS NULL OR t.fan_translation = '') ORDER BY m.created_at DESC LIMIT 50"
    ).bind(profileId).all();
    for (const row of untranslatedFan.results) {
      try {
        let resolved = resolveFanTranslation(row.reply_content, null);
        if (!resolved) {
          const tr = await wfFetch("/api/v4/message/translate?id=" + row.message_reply_id + "&languageId=4&type=messageReply", auth);
          if (tr.status === 200) resolved = resolveFanTranslation(row.reply_content, tr.data.content);
        }
        if (resolved) {
          const existing = await env.DB.prepare("SELECT translation FROM translations WHERE profile_id = ?1 AND message_id = ?2")
            .bind(profileId, row.message_id).first();
          await env.DB.prepare("INSERT OR REPLACE INTO translations (message_id, profile_id, translation, fan_translation) VALUES (?1, ?2, ?3, ?4)")
            .bind(row.message_id, profileId, existing?.translation || null, resolved).run();
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip */ }
}

async function syncAllProfiles(env) {
  const auth = await ensureValidAuth(env);
  await Promise.all(ARTISTS.map((artist) => syncProfile(env, artist.id, auth)));
}

// ========== Router ==========

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method;

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "X-WithFan-Auth, Content-Type",
      },
    });
  }

  try {
    const auth = getAuth(request);

    // API routes
    if (pathname === "/api/profiles" && method === "GET") {
      return handleProfiles(env);
    }

    if (pathname === "/api/messages" && method === "GET") {
      const profileId = url.searchParams.get("profileId") || "12289";
      const params = {
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
        dateFrom: url.searchParams.get("dateFrom"),
        dateTo: url.searchParams.get("dateTo"),
        type: url.searchParams.get("type"),
        q: url.searchParams.get("q"),
      };
      return handleMessages(env, profileId, auth, params);
    }

    if (pathname === "/api/stats" && method === "GET") {
      const profileId = url.searchParams.get("profileId") || "12289";
      const params = {
        year: url.searchParams.get("year"),
        month: url.searchParams.get("month"),
      };
      return handleStats(env, profileId, params);
    }

    if (pathname === "/api/search" && method === "GET") {
      const profileId = url.searchParams.get("profileId") || "12289";
      const q = url.searchParams.get("q") || "";
      const params = {
        limit: url.searchParams.get("limit"),
        offset: url.searchParams.get("offset"),
      };
      return handleSearch(env, profileId, q, params);
    }

    return json({ error: "Not Found" }, 404);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// ========== Entry ==========

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },

  // Cron trigger — runs every 3 minutes
  async scheduled(event, env, ctx) {
    // Ensure tokens table exists for persistence
    try {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS tokens (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
      ).run();
    } catch (e) { /* may already exist */ }

    console.log("Cron: checking token...");
    const auth = await ensureValidAuth(env);
    const payload = decodeJwtPayload(auth);
    console.log("Cron: token valid until", payload ? new Date(payload.exp * 1000).toISOString() : "unknown");

    console.log("Cron: syncing all profiles...");
    await syncAllProfiles(env);
    console.log("Cron: done");
  },
};
