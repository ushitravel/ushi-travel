const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const allowOrigin =
    allowed.includes("*") || allowed.includes(origin) ? (origin || "*") : "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    if (value) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function adminAllowed(request, env) {
  const supplied = request.headers.get("X-Admin-Key") || "";
  return Boolean(env.ADMIN_KEY) && supplied === env.ADMIN_KEY;
}

async function bodyJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function validCode(value) {
  const raw = String(value || "").toUpperCase().replace("USHI", "");
  const code = raw.padStart(3, "0");
  return /^(00[1-9]|010)$/.test(code) ? code : null;
}

function isoAfterDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

async function ensureMonth(env) {
  const month = new Date().toISOString().slice(0, 7);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO consult_slots(month, used_count, limit_count) VALUES (?,0,10)"
  ).bind(month).run();
  return month;
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (path === "/api/health") {
    return json({ ok: true, service: "ushi-travel-api", version: "RC8" });
  }

  // -------- PUBLIC --------
  if (path === "/api/member/claim" && request.method === "POST") {
    const body = await bodyJson(request);
    const code = validCode(body.code);
    const deviceId = String(body.deviceId || "").slice(0, 120);
    if (!code || !deviceId) return json({ ok: false, error: "invalid_request" }, 400);

    const row = await env.DB.prepare(
      "SELECT code,status,device_id,started_at,expires_at,stopped_at FROM member_codes WHERE code=?"
    ).bind(code).first();
    if (!row) return json({ ok: false, error: "invalid_code" }, 404);

    const now = new Date().toISOString();
    const expired = row.expires_at && row.expires_at < now;

    if (row.status === "active" && !expired && row.device_id !== deviceId) {
      return json({ ok: false, error: "already_used" }, 409);
    }
    if (row.status === "stopped") {
      return json({ ok: false, error: "stopped" }, 403);
    }

    if (row.status === "active" && !expired && row.device_id === deviceId) {
      return json({ ok: true, code, startedAt: row.started_at, expiresAt: row.expires_at });
    }

    const startedAt = now;
    const expiresAt = isoAfterDays(7);
    const result = await env.DB.prepare(
      `UPDATE member_codes
       SET status='active', device_id=?, started_at=?, expires_at=?, stopped_at=NULL, updated_at=CURRENT_TIMESTAMP
       WHERE code=? AND (status='unused' OR expires_at < ? OR device_id=?)`
    ).bind(deviceId, startedAt, expiresAt, code, now, deviceId).run();

    if (!result.success || result.meta.changes !== 1) {
      return json({ ok: false, error: "already_used" }, 409);
    }
    return json({ ok: true, code, startedAt, expiresAt });
  }

  if (path === "/api/member/status" && request.method === "POST") {
    const body = await bodyJson(request);
    const code = validCode(body.code);
    const deviceId = String(body.deviceId || "").slice(0, 120);
    if (!code || !deviceId) return json({ ok: false, error: "invalid_request" }, 400);
    const row = await env.DB.prepare(
      "SELECT status,device_id,started_at,expires_at FROM member_codes WHERE code=?"
    ).bind(code).first();
    const active = Boolean(
      row && row.status === "active" && row.device_id === deviceId &&
      row.expires_at && row.expires_at >= new Date().toISOString()
    );
    return json({ ok: true, active, code, startedAt: row?.started_at || null, expiresAt: row?.expires_at || null });
  }

  if (path === "/api/feedback" && request.method === "POST") {
    const body = await bodyJson(request);
    const code = validCode(body.memberCode);
    const improve = String(body.improve || "").trim().slice(0, 3000);
    const wanted = String(body.wantedFeature || "").trim().slice(0, 3000);
    const rating = Math.max(1, Math.min(5, Number(body.rating || 5)));
    if (!improve && !wanted) return json({ ok: false, error: "empty_feedback" }, 400);
    await env.DB.prepare(
      `INSERT INTO feedback(member_code,rating,improve,wanted_feature,user_agent)
       VALUES (?,?,?,?,?)`
    ).bind(code, rating, improve, wanted, request.headers.get("User-Agent") || "").run();
    return json({ ok: true }, 201);
  }

  if (path === "/api/places" && request.method === "GET") {
    const category = url.searchParams.get("category");
    const stmt = category
      ? env.DB.prepare("SELECT * FROM places WHERE active=1 AND publish_status='published' AND category=? ORDER BY updated_at DESC").bind(category)
      : env.DB.prepare("SELECT * FROM places WHERE active=1 AND publish_status='published' ORDER BY updated_at DESC");
    const result = await stmt.all();
    const rows = (result.results || []).map((p) => ({
      ...p,
      aliases: JSON.parse(p.aliases || "[]"),
      route: JSON.parse(p.route || "[]"),
      active: Boolean(p.active),
    }));
    return json({ ok: true, places: rows });
  }

  // -------- ADMIN --------
  if (path.startsWith("/api/admin/") && !adminAllowed(request, env)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  if (path === "/api/admin/codes" && request.method === "GET") {
    await env.DB.prepare(
      "UPDATE member_codes SET status='expired',updated_at=CURRENT_TIMESTAMP WHERE status='active' AND expires_at < ?"
    ).bind(new Date().toISOString()).run();
    const result = await env.DB.prepare(
      "SELECT code,status,device_id,started_at,expires_at,stopped_at,updated_at FROM member_codes ORDER BY code"
    ).all();
    return json({ ok: true, codes: result.results || [] });
  }

  const codeAction = path.match(/^\/api\/admin\/codes\/(001|002|003|004|005|006|007|008|009|010)\/(stop|reset)$/);
  if (codeAction && request.method === "POST") {
    const [, code, action] = codeAction;
    if (action === "stop") {
      await env.DB.prepare(
        "UPDATE member_codes SET status='stopped',stopped_at=?,updated_at=CURRENT_TIMESTAMP WHERE code=?"
      ).bind(new Date().toISOString(), code).run();
    } else {
      await env.DB.prepare(
        "UPDATE member_codes SET status='unused',device_id=NULL,started_at=NULL,expires_at=NULL,stopped_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE code=?"
      ).bind(code).run();
    }
    return json({ ok: true });
  }

  if (path === "/api/admin/feedback" && request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT * FROM feedback ORDER BY id DESC LIMIT 500"
    ).all();
    return json({ ok: true, feedback: result.results || [] });
  }

  if (path.match(/^\/api\/admin\/feedback\/\d+$/) && request.method === "DELETE") {
    const id = Number(path.split("/").pop());
    await env.DB.prepare("DELETE FROM feedback WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  if (path === "/api/admin/places" && request.method === "GET") {
    const result = await env.DB.prepare("SELECT * FROM places ORDER BY id DESC").all();
    const rows = (result.results || []).map((p) => ({
      ...p,
      aliases: JSON.parse(p.aliases || "[]"),
      route: JSON.parse(p.route || "[]"),
    }));
    return json({ ok: true, places: rows });
  }

  if (path === "/api/admin/places" && request.method === "POST") {
    const b = await bodyJson(request);
    const category = ["hotel", "spot", "food"].includes(b.category) ? b.category : null;
    const name = String(b.name || "").trim().slice(0, 300);
    if (!category || !name) return json({ ok: false, error: "invalid_place" }, 400);
    const aliases = Array.isArray(b.aliases) ? b.aliases : [];
    const result = await env.DB.prepare(
      `INSERT INTO places(
        category,name,aliases,score,label,comment,point,reservation,
        maps_query,review_query,address,nearest_station,route,
        source_url,checked_at,publish_status
       )
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      category,
      name,
      JSON.stringify(aliases),
      Math.max(0, Math.min(100, Number(b.score || 80))),
      String(b.label || "📚ウシ評価（事前調査）"),
      String(b.comment || ""),
      String(b.point || ""),
      String(b.reservation || ""),
      String(b.mapsQuery || name),
      String(b.reviewQuery || `${name} reviews official`),
      String(b.address || ""),
      String(b.nearestStation || ""),
      JSON.stringify(Array.isArray(b.route) ? b.route.filter(Boolean).slice(0, 8) : []),
      String(b.sourceUrl || ""),
      String(b.checkedAt || ""),
      b.publishStatus === "draft" ? "draft" : "published"
    ).run();
    return json({ ok: true, id: result.meta.last_row_id }, 201);
  }

  if (path.match(/^\/api\/admin\/places\/\d+$/) && request.method === "PUT") {
    const id = Number(path.split("/").pop());
    const b = await bodyJson(request);
    await env.DB.prepare(
      `UPDATE places SET
        category=?,name=?,aliases=?,score=?,label=?,comment=?,point=?,
        reservation=?,maps_query=?,review_query=?,active=?,
        address=?,nearest_station=?,route=?,source_url=?,checked_at=?,publish_status=?,
        updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(
      b.category,
      b.name,
      JSON.stringify(b.aliases || []),
      Math.max(0, Math.min(100, Number(b.score || 80))),
      b.label || "",
      b.comment || "",
      b.point || "",
      b.reservation || "",
      b.mapsQuery || b.name,
      b.reviewQuery || `${b.name} reviews official`,
      b.active === false ? 0 : 1,
      b.address || "",
      b.nearestStation || "",
      JSON.stringify(Array.isArray(b.route) ? b.route.filter(Boolean).slice(0, 8) : []),
      b.sourceUrl || "",
      b.checkedAt || "",
      b.publishStatus === "draft" ? "draft" : "published",
      id
    ).run();
    return json({ ok: true });
  }

  if (path.match(/^\/api\/admin\/places\/\d+$/) && request.method === "DELETE") {
    const id = Number(path.split("/").pop());
    await env.DB.prepare("DELETE FROM places WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  if (path === "/api/admin/consult" && request.method === "GET") {
    const month = await ensureMonth(env);
    const row = await env.DB.prepare("SELECT * FROM consult_slots WHERE month=?").bind(month).first();
    return json({ ok: true, consult: row });
  }

  if (path === "/api/admin/consult" && request.method === "POST") {
    const month = await ensureMonth(env);
    const b = await bodyJson(request);
    const action = b.action;
    if (action === "use") {
      await env.DB.prepare(
        "UPDATE consult_slots SET used_count=MIN(limit_count,used_count+1),updated_at=CURRENT_TIMESTAMP WHERE month=?"
      ).bind(month).run();
    } else if (action === "reset") {
      await env.DB.prepare(
        "UPDATE consult_slots SET used_count=0,updated_at=CURRENT_TIMESTAMP WHERE month=?"
      ).bind(month).run();
    } else if (action === "set") {
      await env.DB.prepare(
        "UPDATE consult_slots SET used_count=?,limit_count=?,updated_at=CURRENT_TIMESTAMP WHERE month=?"
      ).bind(Number(b.usedCount || 0), Number(b.limitCount || 10), month).run();
    }
    const row = await env.DB.prepare("SELECT * FROM consult_slots WHERE month=?").bind(month).first();
    return json({ ok: true, consult: row });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      return withCors(await handle(request, env), request, env);
    } catch (error) {
      console.error(error);
      return withCors(json({ ok: false, error: "server_error", detail: String(error?.message || error) }, 500), request, env);
    }
  },
};
