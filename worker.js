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

const PLACE_COLUMNS = {
  city_code: "TEXT DEFAULT 'paris'",
  canonical_key: "TEXT DEFAULT ''",
  ai_score: "INTEGER",
  ushi_score: "INTEGER",
  publish_status: "TEXT DEFAULT 'draft'",
  workflow_status: "TEXT DEFAULT 'ai_draft'",
  overview: "TEXT DEFAULT ''",
  travel_experience: "TEXT DEFAULT ''",
  actual_caution: "TEXT DEFAULT ''",
  related_spots: "TEXT DEFAULT '[]'",
  route: "TEXT DEFAULT '[]'",
  area_name: "TEXT DEFAULT ''",
  nearest_rail: "TEXT DEFAULT ''",
  nearest_bus: "TEXT DEFAULT ''",
  recommended_access: "TEXT DEFAULT ''",
  walking_time: "TEXT DEFAULT ''",
  recommended_duration: "TEXT DEFAULT ''",
  nearest_station: "TEXT DEFAULT ''",
  address: "TEXT DEFAULT ''",
  source_url: "TEXT DEFAULT ''",
  source_urls: "TEXT DEFAULT '[]'",
  checked_at: "TEXT DEFAULT ''",
  score_breakdown: "TEXT DEFAULT '{}'",
  ai_generated: "INTEGER DEFAULT 0"
};

let placeColumnsReady = false;

async function ensurePlaceColumns(env) {
  if (placeColumnsReady) return;
  const info = await env.DB.prepare("PRAGMA table_info(places)").all();
  const existing = new Set((info.results || []).map((row) => row.name));

  for (const [name, type] of Object.entries(PLACE_COLUMNS)) {
    if (!existing.has(name)) {
      await env.DB.prepare(`ALTER TABLE places ADD COLUMN ${name} ${type}`).run();
    }
  }

  placeColumnsReady = true;
}

function safeJsonParse(value, fallback) {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function normalizePlaceRow(row) {
  if (!row) return null;
  return {
    ...row,
    aliases: safeJsonParse(row.aliases, []),
    related_spots: safeJsonParse(row.related_spots, []),
    route: safeJsonParse(row.route, []),
    source_urls: safeJsonParse(row.source_urls, []),
    score_breakdown: safeJsonParse(row.score_breakdown, {}),
    active: Boolean(row.active),
    ai_generated: Boolean(row.ai_generated)
  };
}

function text(value, max = 10000) {
  return String(value ?? "").slice(0, max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function placeValues(body) {
  const category = ["hotel", "spot", "food"].includes(body.category)
    ? body.category
    : null;
  const name = text(body.name, 300).trim();
  if (!category || !name) return null;

  const aliases = Array.isArray(body.aliases) ? body.aliases : [];
  const relatedSpots = Array.isArray(body.relatedSpots)
    ? body.relatedSpots
    : Array.isArray(body.related_spots) ? body.related_spots : [];
  const route = Array.isArray(body.route) ? body.route : [];
  const sourceUrls = Array.isArray(body.sourceUrls)
    ? body.sourceUrls
    : Array.isArray(body.source_urls) ? body.source_urls : [];
  const scoreBreakdown =
    body.scoreBreakdown && typeof body.scoreBreakdown === "object"
      ? body.scoreBreakdown
      : body.score_breakdown && typeof body.score_breakdown === "object"
        ? body.score_breakdown
        : {};

  // V7.4のhotelDiagnosisはscore_breakdown内にも保存して、
  // 将来の専用カラム追加前でも消えないようにします。
  if (body.hotelDiagnosis && typeof body.hotelDiagnosis === "object") {
    scoreBreakdown.__hotelDiagnosis = body.hotelDiagnosis;
  }

  const aiScore = numberOrNull(body.aiScore ?? body.ai_score);
  const ushiScore = numberOrNull(body.ushiScore ?? body.ushi_score);
  const score = Math.max(
    0,
    Math.min(100, Number(body.score ?? ushiScore ?? aiScore ?? 80))
  );

  return {
    category,
    name,
    cityCode: text(body.cityCode ?? body.city_code ?? "paris", 80),
    canonicalKey: text(body.canonicalKey ?? body.canonical_key, 300),
    aliases: JSON.stringify(aliases),
    aiScore,
    ushiScore,
    score,
    publishStatus: text(body.publishStatus ?? body.publish_status ?? "draft", 40),
    workflowStatus: text(body.workflowStatus ?? body.workflow_status ?? "ai_draft", 40),
    label: text(body.label, 120),
    overview: text(body.overview ?? body.summary),
    comment: text(body.comment),
    travelExperience: text(body.travelExperience ?? body.travel_experience),
    actualCaution: text(body.actualCaution ?? body.actual_caution),
    point: text(body.point),
    relatedSpots: JSON.stringify(relatedSpots),
    route: JSON.stringify(route),
    areaName: text(body.areaName ?? body.area_name),
    nearestRail: text(body.nearestRail ?? body.nearest_rail ?? body.nearestStation ?? body.nearest_station),
    nearestBus: text(body.nearestBus ?? body.nearest_bus),
    recommendedAccess: text(body.recommendedAccess ?? body.recommended_access),
    walkingTime: text(body.walkingTime ?? body.walking_time),
    recommendedDuration: text(body.recommendedDuration ?? body.recommended_duration),
    nearestStation: text(body.nearestStation ?? body.nearest_station ?? body.nearestRail ?? body.nearest_rail),
    address: text(body.address),
    sourceUrl: text(body.sourceUrl ?? body.source_url),
    sourceUrls: JSON.stringify(sourceUrls),
    checkedAt: text(body.checkedAt ?? body.checked_at, 40),
    reservation: text(body.reservation),
    scoreBreakdown: JSON.stringify(scoreBreakdown),
    aiGenerated: body.aiGenerated || body.ai_generated ? 1 : 0,
    mapsQuery: text(body.mapsQuery ?? body.maps_query ?? name),
    reviewQuery: text(body.reviewQuery ?? body.review_query ?? `${name} reviews official`),
    active: body.active === false ? 0 : 1
  };
}

async function getPublicPlaces(env, url) {
  await ensurePlaceColumns(env);
  const category = url.searchParams.get("category");
  const city = url.searchParams.get("city");

  const where = ["active=1", "(publish_status='published' OR workflow_status='publish_ready')"];
  const bindings = [];

  if (category) {
    where.push("category=?");
    bindings.push(category);
  }
  if (city) {
    where.push("city_code=?");
    bindings.push(city);
  }

  const stmt = env.DB.prepare(
    `SELECT * FROM places WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`
  );
  const result = bindings.length
    ? await stmt.bind(...bindings).all()
    : await stmt.all();

  return (result.results || []).map(normalizePlaceRow);
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (path === "/api/health") {
    await ensurePlaceColumns(env);
    return json({
      ok: true,
      service: "ushi-travel-api",
      version: "RC9-FULL-PLACE-FIELD-PERSISTENCE",
      placeColumnsReady: true
    });
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
    return json({
      ok: true,
      active,
      code,
      startedAt: row?.started_at || null,
      expiresAt: row?.expires_at || null
    });
  }

  if (path === "/api/feedback" && request.method === "POST") {
    const body = await bodyJson(request);
    const code = validCode(body.memberCode);
    const improve = String(body.improve || "").trim().slice(0, 3000);
    const wanted = String(body.wantedFeature || "").trim().slice(0, 3000);
    const rating = Math.max(1, Math.min(5, Number(body.rating || 5)));
    if (!improve && !wanted) {
      return json({ ok: false, error: "empty_feedback" }, 400);
    }
    await env.DB.prepare(
      `INSERT INTO feedback(member_code,rating,improve,wanted_feature,user_agent)
       VALUES (?,?,?,?,?)`
    ).bind(
      code,
      rating,
      improve,
      wanted,
      request.headers.get("User-Agent") || ""
    ).run();
    return json({ ok: true }, 201);
  }

  if (
    (path === "/api/places" || path === "/api/public/places") &&
    request.method === "GET"
  ) {
    const places = await getPublicPlaces(env, url);
    return json({ ok: true, places });
  }

  const publicDetail = path.match(/^\/api\/public\/places\/([^/]+)$/);
  if (publicDetail && request.method === "GET") {
    await ensurePlaceColumns(env);
    const key = decodeURIComponent(publicDetail[1]);
    const row = await env.DB.prepare(
      `SELECT * FROM places
       WHERE active=1
         AND (publish_status='published' OR workflow_status='publish_ready')
         AND (CAST(id AS TEXT)=? OR canonical_key=? OR name=?)
       LIMIT 1`
    ).bind(key, key, key).first();

    if (!row) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, place: normalizePlaceRow(row) });
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

  const codeAction = path.match(
    /^\/api\/admin\/codes\/(001|002|003|004|005|006|007|008|009|010)\/(stop|reset)$/
  );
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
    await ensurePlaceColumns(env);
    const result = await env.DB.prepare(
      "SELECT * FROM places ORDER BY id DESC"
    ).all();
    return json({
      ok: true,
      places: (result.results || []).map(normalizePlaceRow)
    });
  }

  if (path === "/api/admin/places" && request.method === "POST") {
    await ensurePlaceColumns(env);
    const b = placeValues(await bodyJson(request));
    if (!b) return json({ ok: false, error: "invalid_place" }, 400);

    const result = await env.DB.prepare(
      `INSERT INTO places(
        city_code,category,name,canonical_key,aliases,ai_score,ushi_score,score,
        publish_status,workflow_status,label,overview,comment,travel_experience,
        actual_caution,point,related_spots,route,area_name,nearest_rail,
        nearest_bus,recommended_access,walking_time,recommended_duration,
        nearest_station,address,source_url,source_urls,checked_at,reservation,
        score_breakdown,ai_generated,maps_query,review_query,active
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      b.cityCode,b.category,b.name,b.canonicalKey,b.aliases,b.aiScore,b.ushiScore,b.score,
      b.publishStatus,b.workflowStatus,b.label,b.overview,b.comment,b.travelExperience,
      b.actualCaution,b.point,b.relatedSpots,b.route,b.areaName,b.nearestRail,
      b.nearestBus,b.recommendedAccess,b.walkingTime,b.recommendedDuration,
      b.nearestStation,b.address,b.sourceUrl,b.sourceUrls,b.checkedAt,b.reservation,
      b.scoreBreakdown,b.aiGenerated,b.mapsQuery,b.reviewQuery,b.active
    ).run();

    return json({ ok: true, id: result.meta.last_row_id }, 201);
  }

  if (path.match(/^\/api\/admin\/places\/\d+$/) && request.method === "PUT") {
    await ensurePlaceColumns(env);
    const id = Number(path.split("/").pop());
    const b = placeValues(await bodyJson(request));
    if (!b) return json({ ok: false, error: "invalid_place" }, 400);

    const result = await env.DB.prepare(
      `UPDATE places SET
        city_code=?,category=?,name=?,canonical_key=?,aliases=?,
        ai_score=?,ushi_score=?,score=?,publish_status=?,workflow_status=?,
        label=?,overview=?,comment=?,travel_experience=?,actual_caution=?,
        point=?,related_spots=?,route=?,area_name=?,nearest_rail=?,nearest_bus=?,
        recommended_access=?,walking_time=?,recommended_duration=?,
        nearest_station=?,address=?,source_url=?,source_urls=?,checked_at=?,
        reservation=?,score_breakdown=?,ai_generated=?,maps_query=?,review_query=?,
        active=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(
      b.cityCode,b.category,b.name,b.canonicalKey,b.aliases,
      b.aiScore,b.ushiScore,b.score,b.publishStatus,b.workflowStatus,
      b.label,b.overview,b.comment,b.travelExperience,b.actualCaution,
      b.point,b.relatedSpots,b.route,b.areaName,b.nearestRail,b.nearestBus,
      b.recommendedAccess,b.walkingTime,b.recommendedDuration,
      b.nearestStation,b.address,b.sourceUrl,b.sourceUrls,b.checkedAt,
      b.reservation,b.scoreBreakdown,b.aiGenerated,b.mapsQuery,b.reviewQuery,
      b.active,id
    ).run();

    if (!result.success) {
      return json({ ok: false, error: "update_failed" }, 500);
    }
    return json({ ok: true, id });
  }

  if (path.match(/^\/api\/admin\/places\/\d+$/) && request.method === "DELETE") {
    const id = Number(path.split("/").pop());
    await env.DB.prepare("DELETE FROM places WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  if (path === "/api/admin/consult" && request.method === "GET") {
    const month = await ensureMonth(env);
    const row = await env.DB.prepare(
      "SELECT * FROM consult_slots WHERE month=?"
    ).bind(month).first();
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

    const row = await env.DB.prepare(
      "SELECT * FROM consult_slots WHERE month=?"
    ).bind(month).first();
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
      return withCors(
        json(
          {
            ok: false,
            error: "server_error",
            detail: String(error?.message || error)
          },
          500
        ),
        request,
        env
      );
    }
  }
};
