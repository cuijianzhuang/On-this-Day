/**
 * "那年今日" Cloudflare Worker
 * 路径结构: Photos/MobileBackup/iPhone/{年}/{月}/{文件}
 * 月份下没有按天分文件夹。文件名形如 IMG_20260627_123456.jpg 的靠文件名里的 YYYYMMDD 判断拍摄日期；
 * 像 IMG_1017.JPG 这种纯序号命名、文件名没有日期的，JPEG 读 EXIF DateTimeOriginal，其他格式回退用 R2 上传时间近似
 * 绑定: R2 bucket 需在 wrangler.toml 中绑定为 PHOTOS
 *
 * HEIC 服务端转码需要 Workers Paid 套餐（CPU 时间限制更宽松，解码一张图动辄几百毫秒）
 */

import { createHash } from "node:crypto";
import { WorkflowEntrypoint } from "cloudflare:workers";


const IMAGE_EXT = /\.(jpe?g|png|heic|gif|webp)$/i;
const VIDEO_EXT = /\.(mov|mp4)$/i;
const BASE_PREFIX = "Photos/MobileBackup/iPhone/";

// 记录最近一次有人查看的 month/day，给 Cron 任务做优先级参考
// 改用 KV：Cron 每 10 分钟读一次，KV 读比 D1 SELECT 快，且全局一份（不同 PoP 共享同一个值）
async function getLastViewedDay(env) {
  return env.KV.get("last_viewed_day", { type: "json" });
}

async function setLastViewedDay(env, month, day) {
  await env.KV.put("last_viewed_day", JSON.stringify({ month, day }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/memories") {
      return handleMemories(request, env, url, ctx);
    }

    if (url.pathname.startsWith("/img/")) {
      return handleImage(request, env, url);
    }

    if (url.pathname.startsWith("/thumb/")) {
      return handleThumb(request, env, url);
    }

    if (url.pathname === "/admin/score-photos") {
      return handleScorePhotos(request, env, url);
    }

    if (url.pathname === "/admin/locate-photos") {
      return handleLocatePhotos(request, env, url);
    }

    if (url.pathname === "/admin/convert-heic-photos") {
      return handleConvertHeicPhotos(request, env, url);
    }

    if (url.pathname === "/admin/purge-cache") {
      return handlePurgeCache(request, env, url);
    }

    if (url.pathname === "/admin/backfill-photos-index") {
      return handleBackfillPhotosIndex(request, env, url);
    }

    if (url.pathname === "/admin/reindex-photo-dates") {
      return handleReindexPhotoDates(request, env, url);
    }

    if (url.pathname === "/admin/backfill-workflows") {
      return handleBackfillWorkflows(request, env, url);
    }

    if (url.pathname === "/admin/test-telegram") {
      try {
        await sendDailyMemories(env);
        return new Response("OK", { status: 200 });
      } catch (err) {
        return new Response("Error: " + err.message, { status: 500 });
      }
    }

    // ── 运维控制台：整站在 Cloudflare Access 后面，页面和接口都不再单独校验 token ──
    if (url.pathname === "/admin/ops") {
      return env.ASSETS.fetch(new Request(new URL("/admin-ops.html", request.url), request));
    }
    if (url.pathname === "/admin/ops-status") {
      return handleOpsStatus(request, env, url);
    }
    if (url.pathname === "/admin/photo-info") {
      return handlePhotoInfo(request, env, url);
    }
    if (url.pathname === "/admin/photo-fix" && request.method === "POST") {
      return handlePhotoFix(request, env, url);
    }
    if (url.pathname === "/admin/reset-flag" && request.method === "POST") {
      return handleResetFlag(request, env, url);
    }

    if (url.pathname === "/api/map-photos") {
      return handleMapPhotos(request, env, url);
    }

    if (url.pathname === "/api/exif") {
      return handleExif(request, env, url);
    }

    if (url.pathname === "/api/static-map") {
      return handleStaticMap(request, env, url);
    }

    if (url.pathname === "/og-image") {
      return handleOgImage(request, env, url);
    }

    if (url.pathname === "/app-icon") {
      return handleAppIcon(request, env, url);
    }

    if (url.pathname === "/api/top-loved") {
      return handleTopLoved(request, env, url);
    }

    if (url.pathname === "/api/search") {
      return handleSearch(request, env, url);
    }

    if (url.pathname === "/api/note") {
      return handleNote(request, env, url);
    }

    if (url.pathname === "/loved") {
      return new Response(LOVED_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/recap") {
      return handleRecap(request, env, url);
    }

    if (url.pathname === "/recap") {
      return new Response(RECAP_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/poem") {
      return handlePoem(request, env, url);
    }

    if (url.pathname === "/api/onthisday") {
      return handleOnThisDay(request, env, url);
    }

    if (url.pathname === "/api/upload-heic-preview" && request.method === "POST") {
      return handleUploadHeicPreview(request, env, url);
    }

    if (url.pathname === "/map") {
      return new Response(MAP_HTML(env.MAPBOX_PUBLIC_TOKEN || ""), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // 实时共享房间：每个日期一个 Durable Object，家人同时在线时看到彼此人数 + 实时点赞
    if (url.pathname.startsWith("/api/room/")) {
      const dateKey = url.pathname.slice("/api/room/".length);
      if (/^\d{2}-\d{2}$/.test(dateKey)) {
        const id = env.MEMORY_ROOM.idFromName(dateKey);
        return env.MEMORY_ROOM.get(id).fetch(request);
      }
    }

    // 首页：静态 HTML 出来后动态注入 og meta——分享到微信/Telegram/Twitter 时
    // 预览卡片能带上"当天最高分照片 + 日期标题"，链接不再是光秃秃一行字
    if (url.pathname === "/") {
      const assetResp = await env.ASSETS.fetch(request);
      return injectOgTags(assetResp, url);
    }

    // 其余请求（/favicon.svg、/app.css、/app.js 等）交给 Static Assets CDN
    return env.ASSETS.fetch(request);
  },

  // Cron 定时任务：按 cron 表达式区分任务
  // */10 * * * *  → 维护任务（打分/地点/回填）
  // 0 16 * * *    → 北京时间零点，把当天历史精选推送到 Telegram
  async scheduled(event, env, ctx) {
    if (event.cron === "0 16 * * *") {
      ctx.waitUntil(sendDailyMemories(env));
    } else {
      ctx.waitUntil(runBackgroundMaintenance(env));
    }
  },

  // R2 Event Notification → Queue → 此处仅触发 PhotoProcessingWorkflow。
  // 原来的"索引+打分+定位"全部移入 Workflow 的独立步骤：每步持久化、独立重试，
  // AI 超时不再导致整条消息重试，HEIC 也能先转码再打分，彻底解决 exceededMemory 问题。
  // 删除操作简单且无需重试，继续在此内联处理。
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        const event = message.body;
        const key = event.object?.key;
        if (!key) { message.ack(); continue; }

        const uploadActions = ["PutObject", "CompleteMultipartUpload", "CopyObject"];
        const deleteActions = ["DeleteObject", "LifecycleDeletion"];

        if (uploadActions.includes(event.action)) {
          // 触发持久化 Workflow，立即 ack——后续所有工作由 Workflow 负责重试
          await env.PHOTO_WORKFLOW.create({ params: { key } });
        } else if (deleteActions.includes(event.action)) {
          const removed = await removePhotoIndex(env, key);
          if (removed) await purgeDayCache(removed.month, removed.day);
        }
        message.ack();
      } catch (err) {
        console.error("queue: workflow trigger failed", message.body, err);
        message.retry();
      }
    }
  },
};

// ── 每日零点精选推送 Telegram ───────────────────────────────────────────────────

// 给 Telegram 推送预生成 JPEG 缩略图，返回 PREVIEWS 桶的公开直链。
// 不发 /thumb/ 的 302——Telegram 抓 URL 图片时对重定向和 WebP 的支持都不可靠，
// JPEG 直链（无跳转、格式明确）是最稳的形态。已生成过的直接复用。
async function tgPhotoUrl(env, key) {
  const thumbKey = `tg/${key.replace(/\.[^.]+$/, "")}.jpg`;
  if (!(await env.PREVIEWS.head(thumbKey))) {
    const object = await env.PHOTOS.get(key);
    if (!object) return null;
    try {
      const transformed = await env.IMAGES.input(object.body)
        .transform({ width: 1280, fit: "scale-down" })
        .output({ format: "image/jpeg", quality: 85 });
      const buf = await transformed.response().arrayBuffer();
      await env.PREVIEWS.put(thumbKey, buf, {
        httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
      });
    } catch {
      return null; // 解码失败（损坏文件等）就跳过这张，别让一张坏图拖垮整次推送
    }
  }
  return `${env.PREVIEWS_PUBLIC_URL}/${thumbKey.split("/").map(encodeURIComponent).join("/")}`;
}

// 支持 TELEGRAM_CHAT_ID 为单个 ID 或逗号分隔多个 ID
function tgChatIds(env) {
  if (!env.TELEGRAM_CHAT_ID) return [];
  return String(env.TELEGRAM_CHAT_ID)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sendDailyMemories(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("sendDailyMemories: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set, skipping");
    return;
  }

  // 北京时间当前日期（UTC+8）
  const { month, day } = bjToday();

  // 查当天历史上评分最高的图片，最多取 5 张。
  // LEFT JOIN：还没打完分的新照片（比如当天刚上传、Workflow 还在排队）按上传时间兜底补位，
  // 不然"今天刚拍的"反而永远缺席零点推送。SQLite 把 NULL 当最小值，DESC 排序自然垫底，
  // 正好实现"有分的按分数优先，没分的按上传时间补位"
  const { results: candidates } = await env.DB.prepare(
    `SELECT pi.key AS key, pi.year AS year
     FROM photos_index pi
     LEFT JOIN photo_scores ps ON pi.key = ps.key
     WHERE pi.month = ? AND pi.day = ? AND pi.type = 'image'
     ORDER BY ps.score DESC, pi.uploaded DESC LIMIT 5`
  ).bind(month, day).all();

  if (!candidates.length) {
    console.log(`sendDailyMemories: no photos for ${month}-${day}`);
    return;
  }

  // 逐张预生成 JPEG 直链，生成失败的跳过
  const photos = [];
  for (const p of candidates) {
    const photoUrl = await tgPhotoUrl(env, p.key);
    if (photoUrl) photos.push({ ...p, photoUrl });
  }
  if (!photos.length) {
    console.log(`sendDailyMemories: all thumbnail generations failed for ${month}-${day}`);
    return;
  }

  const years = [...new Set(photos.map((p) => p.year))].sort();
  const monthInt = parseInt(month);
  const dayInt = parseInt(day);

  // 今日诗词（复用现有缓存逻辑）
  let poemLine = "";
  try {
    const poem = await getDailyPoem(env);
    if (poem?.content) {
      poemLine = `「${poem.content}」`;
      if (poem.dynasty || poem.author) {
        poemLine += ` —— ${[poem.dynasty, poem.author].filter(Boolean).join("·")}`;
        if (poem.title) poemLine += `《${poem.title}》`;
      }
    }
  } catch { /* 诗词接口挂了不影响推送 */ }

  const yearDesc = years.length > 1
    ? `${years[0]}–${years[years.length - 1]} 年`
    : `${years[0]} 年`;

  const caption = [
    `📅 ${monthInt} 月 ${dayInt} 日，那年今日`,
    ``,
    `横跨 ${years.length} 个年头 · ${photos.length} 张精选`,
    `来自 ${yearDesc}`,
    poemLine ? `` : null,
    poemLine || null,
    ``,
    `🔗 memories.cuijianzhuang.com/?month=${month}&day=${day}`,
  ].filter((l) => l !== null).join("\n");

  const tgBase = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const chatIds = tgChatIds(env);

  for (const chatId of chatIds) {
    let resp;
    if (photos.length === 1) {
      resp = await fetch(`${tgBase}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          photo: photos[0].photoUrl,
          caption,
        }),
      });
    } else {
      const media = photos.map((p, i) => ({
        type: "photo",
        media: p.photoUrl,
        ...(i === 0 ? { caption } : {}),
      }));
      resp = await fetch(`${tgBase}/sendMediaGroup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, media }),
      });
    }

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`sendDailyMemories: Telegram API error for chat ${chatId}`, resp.status, body);
    } else {
      console.log(`sendDailyMemories: sent ${photos.length} photos for ${month}-${day} → chat ${chatId}`);
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// 后加的辅助表（表态镜像/手记）不走手动 schema.sql 流程，运行时自动建表，
// 每个 isolate 只跑一次，之后就是纯内存判断
let _auxTablesReady = false;
async function ensureAuxTables(env) {
  if (_auxTablesReady) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS photo_reactions (key TEXT NOT NULL, emoji TEXT NOT NULL, " +
      "count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (key, emoji))"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS photo_notes (key TEXT PRIMARY KEY, note TEXT NOT NULL, updated_at TEXT)"
    ),
    // /api/recap 按年查询用；索引是库级别的，任何一条请求创建过一次之后永久生效
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_photos_index_year ON photos_index(year)"
    ),
  ]);
  _auxTablesReady = true;
}

// 北京时间（UTC+8）的今天，返回 { month: "MM", day: "DD" }
function bjToday() {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return {
    month: String(bj.getUTCMonth() + 1).padStart(2, "0"),
    day: String(bj.getUTCDate()).padStart(2, "0"),
  };
}

// ── OG 分享卡片 ────────────────────────────────────────────────────────────────
// /og-image?month=MM&day=DD：当天最高分照片裁成 1200×630 JPEG（OG 标准尺寸）。
// 成品按张缓存在 PREVIEWS（og/ 前缀），响应本身走边缘缓存一天——分数更新后
// 第二天换封面
async function handleOgImage(request, env, url) {
  const today = bjToday();
  const month = /^\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : today.month;
  const day = /^\d{2}$/.test(url.searchParams.get("day") || "") ? url.searchParams.get("day") : today.day;

  const cache = caches.default;
  const cacheKey = new Request(`${SITE_ORIGIN}/og-image?month=${month}&day=${day}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const { results } = await env.DB.prepare(
    `SELECT pi.key AS key FROM photos_index pi
     LEFT JOIN photo_scores ps ON pi.key = ps.key
     WHERE pi.month = ? AND pi.day = ? AND pi.type = 'image'
     ORDER BY ps.score DESC, pi.uploaded DESC LIMIT 1`
  ).bind(month, day).all();
  if (!results.length) return new Response("Not Found", { status: 404 });
  const key = results[0].key;

  const ogKey = `og/${key.replace(/\.[^.]+$/, "")}.jpg`;
  let buf;
  const existing = await env.PREVIEWS.get(ogKey);
  if (existing) {
    buf = await existing.arrayBuffer();
  } else {
    const object = await env.PHOTOS.get(key);
    if (!object) return new Response("Not Found", { status: 404 });
    try {
      const transformed = await env.IMAGES.input(object.body)
        .transform({ width: 1200, height: 630, fit: "cover" })
        .output({ format: "image/jpeg", quality: 82 });
      buf = await transformed.response().arrayBuffer();
    } catch {
      return new Response("Unprocessable", { status: 422 });
    }
    await env.PREVIEWS.put(ogKey, buf, {
      httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
    });
  }

  const resp = new Response(buf, {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
}

// ── 全家最爱 ──────────────────────────────────────────────────────────────────
// 跨所有日期聚合表态计数（数据来自 MemoryRoom 写入的 photo_reactions 镜像表）。
// 注意：镜像从部署后开始积累，历史表态要等对应日期的房间再次有人表态才会补进来
async function handleTopLoved(request, env, url) {
  await ensureAuxTables(env);
  const cache = caches.default;
  const cacheKey = new Request(`${SITE_ORIGIN}/api/top-loved`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const { results } = await env.DB.prepare(
    `SELECT pr.key AS key, SUM(pr.count) AS total, pi.year, pi.month, pi.day, pi.type
     FROM photo_reactions pr
     JOIN photos_index pi ON pr.key = pi.key
     GROUP BY pr.key
     HAVING total > 0
     ORDER BY total DESC
     LIMIT 24`
  ).all();

  const photos = results.map((r) => ({
    key: r.key,
    url: `/img/${encodeURIComponent(r.key)}`,
    type: r.type,
    total: r.total,
    year: r.year,
    month: r.month,
    day: r.day,
  }));

  const response = new Response(JSON.stringify({ photos }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

// ── 年度回忆放映 ──────────────────────────────────────────────────────────────
// 取某一年 AI 评分最高的 40 张，按时间顺序放映。没传 year 就用最近一个有打分照片的年份
async function handleRecap(request, env, url) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const { results: yearRows } = await env.DB.prepare(
    `SELECT DISTINCT pi.year AS year FROM photos_index pi
     JOIN photo_scores ps ON ps.key = pi.key
     WHERE pi.type = 'image' AND ps.score IS NOT NULL
     ORDER BY pi.year DESC`
  ).all();
  const years = yearRows.map((r) => r.year);

  let year = url.searchParams.get("year");
  if (!/^\d{4}$/.test(year || "")) year = years[0] || String(new Date().getUTCFullYear());

  const { results } = await env.DB.prepare(
    `SELECT pi.key AS key, pi.month, pi.day, ps.caption, pp.name AS place
     FROM photos_index pi
     JOIN photo_scores ps ON ps.key = pi.key
     LEFT JOIN photo_places pp ON pp.key = pi.key
     WHERE pi.year = ? AND pi.type = 'image' AND ps.score IS NOT NULL
     ORDER BY ps.score DESC LIMIT 40`
  ).bind(year).all();
  // 精选完按拍摄时间排回去，放映是"一年走过来"的叙事顺序
  results.sort((a, b) => (a.month + a.day).localeCompare(b.month + b.day));

  const photos = results.map((r) => ({
    key: r.key,
    url: `/img/${encodeURIComponent(r.key)}`,
    month: r.month,
    day: r.day,
    caption: r.caption || "",
    place: r.place || "",
  }));

  const response = new Response(JSON.stringify({ year, years, photos }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

const RECAP_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>年度回忆 · 那年今日</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; user-select: none; -webkit-user-select: none; }
  body {
    margin: 0; background: #000; color: #fff; overflow: hidden;
    height: 100dvh; font-family: "SF Pro Display", -apple-system, "PingFang SC", sans-serif;
  }
  #stage { position: fixed; inset: 0; }
  #stage img {
    position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
    opacity: 0; transition: opacity 1.1s ease;
  }
  #stage img.on { opacity: 1; }
  #stage img.kb { animation: kenburns 6s ease-out forwards; }
  @keyframes kenburns { from { transform: scale(1); } to { transform: scale(1.07); } }
  #intro {
    position: fixed; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 0.6rem;
    background: #000; z-index: 5; transition: opacity 1s ease;
  }
  #intro.hide { opacity: 0; pointer-events: none; }
  #intro .y { font-size: clamp(3rem, 12vw, 6rem); font-weight: 700; letter-spacing: 0.02em; }
  #intro .t { color: #8a8a8f; font-size: 0.95rem; letter-spacing: 0.35em; text-transform: uppercase; }
  #caption {
    position: fixed; left: max(1.4rem, env(safe-area-inset-left)); bottom: max(1.6rem, env(safe-area-inset-bottom));
    z-index: 3; max-width: 72vw; text-shadow: 0 1px 10px rgba(0,0,0,0.8);
  }
  #caption .d { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.25rem; }
  #caption .c { font-size: 0.8rem; color: rgba(255,255,255,0.75); line-height: 1.5; }
  #bar { position: fixed; top: 0; left: 0; right: 0; height: 3px; z-index: 4; background: rgba(255,255,255,0.14); }
  #bar i { display: block; height: 100%; width: 0; background: #fff; transition: width 0.2s linear; }
  .btn {
    position: fixed; z-index: 6; width: 38px; height: 38px; border-radius: 50%;
    border: none; display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.12); backdrop-filter: blur(12px); color: #fff;
    cursor: pointer; text-decoration: none; font-size: 0.9rem;
  }
  #back { top: max(1rem, env(safe-area-inset-top)); left: max(1rem, env(safe-area-inset-left)); }
  #music { top: max(1rem, env(safe-area-inset-top)); right: max(1rem, env(safe-area-inset-right)); }
  #yearNav {
    position: fixed; bottom: max(1.5rem, env(safe-area-inset-bottom)); right: max(1.2rem, env(safe-area-inset-right));
    z-index: 6; display: flex; gap: 0.4rem;
  }
  #yearNav a {
    color: rgba(255,255,255,0.55); text-decoration: none; font-size: 0.78rem;
    padding: 0.25rem 0.6rem; border-radius: 999px; background: rgba(0,0,0,0.35); backdrop-filter: blur(8px);
  }
  #yearNav a.cur { color: #000; background: rgba(255,255,255,0.9); font-weight: 600; }
  #empty { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; color: #6e6e73; z-index: 5; }
  svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
</style>
</head>
<body>
  <div id="stage"><img id="imgA" /><img id="imgB" /></div>
  <div id="intro"><div class="t">Year in Review</div><div class="y" id="introYear"></div></div>
  <div id="bar"><i id="barFill"></i></div>
  <div id="caption"><div class="d" id="capDate"></div><div class="c" id="capText"></div></div>
  <a class="btn" id="back" href="/" title="回到今天"><svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg></a>
  <button class="btn" id="music" title="背景音乐"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></button>
  <div id="yearNav"></div>
  <div id="empty">这一年还没有打过分的照片</div>
  <audio id="bgm" loop preload="none"><source src="https://image.cuijianzhuang.com/forest.mp3" type="audio/mpeg" /></audio>
<script>
  var params = new URLSearchParams(location.search);
  var qs = params.get('year') ? '?year=' + encodeURIComponent(params.get('year')) : '';
  var photos = [], idx = -1, timer = null, paused = false, useA = true;
  var DURATION = 5000;
  var imgA = document.getElementById('imgA'), imgB = document.getElementById('imgB');
  var barFill = document.getElementById('barFill');

  function thumbOf(p) { return p.url.replace('/img/', '/thumb/') + '?w=1600&q=85&fit=scale-down'; }

  fetch('/api/recap' + qs).then(function (r) { return r.json(); }).then(function (data) {
    document.getElementById('introYear').textContent = data.year;
    var nav = document.getElementById('yearNav');
    nav.innerHTML = (data.years || []).map(function (y) {
      return '<a href="/recap?year=' + y + '"' + (y === data.year ? ' class="cur"' : '') + '>' + y + '</a>';
    }).join('');
    photos = data.photos || [];
    if (!photos.length) {
      document.getElementById('intro').classList.add('hide');
      document.getElementById('empty').style.display = 'flex';
      return;
    }
    setTimeout(function () {
      document.getElementById('intro').classList.add('hide');
      next();
    }, 1800);
  });

  function show(i) {
    idx = (i + photos.length) % photos.length;
    var p = photos[idx];
    var incoming = useA ? imgA : imgB;
    var outgoing = useA ? imgB : imgA;
    useA = !useA;
    incoming.classList.remove('on', 'kb');
    incoming.src = thumbOf(p);
    var reveal = function () {
      incoming.classList.add('on', 'kb');
      outgoing.classList.remove('on');
      document.getElementById('capDate').textContent = parseInt(p.month) + ' 月 ' + parseInt(p.day) + ' 日';
      document.getElementById('capText').textContent = [p.caption, p.place].filter(Boolean).join(' · ');
      barFill.style.width = ((idx + 1) / photos.length * 100) + '%';
      // 预加载下一张
      var nx = new Image(); nx.src = thumbOf(photos[(idx + 1) % photos.length]);
      schedule();
    };
    if (incoming.complete && incoming.naturalWidth) reveal();
    else { incoming.onload = reveal; incoming.onerror = function () { schedule(); }; }
  }

  function schedule() {
    clearTimeout(timer);
    if (!paused) timer = setTimeout(next, DURATION);
  }
  function next() { show(idx + 1); }
  function prev() { show(idx - 1); }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); clearTimeout(timer); next(); }
    if (e.key === 'ArrowLeft') { clearTimeout(timer); prev(); }
    if (e.key === 'Escape') location.href = '/';
  });
  // 点击：左 1/3 上一张，右 2/3 下一张；长按暂停由 pointerdown/up 控制
  var pressTimer = null;
  document.getElementById('stage').addEventListener('pointerdown', function () {
    pressTimer = setTimeout(function () { paused = true; clearTimeout(timer); pressTimer = null; }, 350);
  });
  document.getElementById('stage').addEventListener('pointerup', function (e) {
    if (pressTimer) {
      clearTimeout(pressTimer); pressTimer = null;
      clearTimeout(timer);
      if (e.clientX < window.innerWidth / 3) prev(); else next();
    } else if (paused) {
      paused = false; schedule();
    }
  });

  var bgm = document.getElementById('bgm'), musicOn = false;
  document.getElementById('music').onclick = function () {
    musicOn = !musicOn;
    this.style.opacity = musicOn ? 1 : 0.55;
    if (musicOn) { bgm.volume = 0.4; bgm.play().catch(function () {}); } else bgm.pause();
  };
</script>
</body>
</html>`;

// ── 照片手记 ──────────────────────────────────────────────────────────────────
// 家人给照片写的文字注解（谁拍的、当时发生了什么）。站点面向家庭成员公开，
// 跟表态一样不做身份校验，只做长度和 key 存在性约束
async function handleNote(request, env, url) {
  await ensureAuxTables(env);

  if (request.method === "GET") {
    const key = url.searchParams.get("key") || "";
    if (!key) return new Response("Bad Request", { status: 400 });
    const row = await env.DB.prepare("SELECT note, updated_at FROM photo_notes WHERE key = ?")
      .bind(key).first();
    return new Response(JSON.stringify({ note: row?.note || "", updated_at: row?.updated_at || null }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return new Response("Bad Request", { status: 400 }); }
    const key = typeof body.key === "string" ? body.key : "";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!key || note.length > 500) return new Response("Bad Request", { status: 400 });
    // key 必须是真实存在的照片，别让这张表变成任意写入的垃圾桶
    const exists = await env.DB.prepare("SELECT 1 FROM photos_index WHERE key = ?").bind(key).first();
    if (!exists) return new Response("Not Found", { status: 404 });

    if (!note) {
      await env.DB.prepare("DELETE FROM photo_notes WHERE key = ?").bind(key).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO photo_notes (key, note, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at"
      ).bind(key, note, new Date().toISOString()).run();
    }
    return new Response(JSON.stringify({ ok: true, note }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return new Response("Method Not Allowed", { status: 405 });
}

// ── 照片搜索 ──────────────────────────────────────────────────────────────────
// 搜 AI 生成的中文说明（photo_scores.caption）和拍摄地名（photo_places.name）。
// 用 LIKE 子串匹配而不是 FTS5——FTS5 默认分词器不吃中文（要 trigram 扩展），
// 而 LIKE '%词%' 对中文天然就是正确的子串语义；一万多行的表扫一遍毫无压力
async function handleSearch(request, env, url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 1 || q.length > 40) {
    return new Response(JSON.stringify({ error: "q required, 1-40 chars" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  // 转义 LIKE 元字符，用户输入的 % _ 按字面匹配
  const like = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
  const { results } = await env.DB.prepare(
    `SELECT pi.key AS key, pi.year, pi.month, pi.day, ps.caption, pp.name AS place
     FROM photos_index pi
     LEFT JOIN photo_scores ps ON ps.key = pi.key
     LEFT JOIN photo_places pp ON pp.key = pi.key
     WHERE pi.type = 'image' AND (ps.caption LIKE ?1 ESCAPE '\\' OR pp.name LIKE ?1 ESCAPE '\\')
     ORDER BY pi.year DESC, pi.month DESC, pi.day DESC
     LIMIT 60`
  ).bind(like).all();

  const photos = results.map((r) => ({
    key: r.key,
    url: `/img/${encodeURIComponent(r.key)}`,
    year: r.year,
    month: r.month,
    day: r.day,
    caption: r.caption || "",
    place: r.place || "",
  }));
  return new Response(JSON.stringify({ q, photos }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

const LOVED_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>全家最爱 · 那年今日</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #000; color: #f5f5f7; min-height: 100vh;
    font-family: "SF Pro Display", -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    padding: 3.5rem 1.2rem 4rem;
  }
  .back {
    position: fixed; top: max(1rem, env(safe-area-inset-top)); left: max(1rem, env(safe-area-inset-left));
    width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); color: #fff; text-decoration: none; z-index: 5;
  }
  h1 { text-align: center; font-size: 1.5rem; margin: 1rem 0 0.3rem; letter-spacing: -0.01em; }
  .sub { text-align: center; color: #8a8a8f; font-size: 0.82rem; margin-bottom: 2rem; }
  .grid { max-width: 1000px; margin: 0 auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; }
  @media (max-width: 640px) { .grid { grid-template-columns: repeat(2, 1fr); gap: 10px; } }
  .card {
    position: relative; border-radius: 10px; overflow: hidden; display: block;
    background: #1c1c1e; aspect-ratio: 1; text-decoration: none;
  }
  .card img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0; transition: opacity 0.35s ease; }
  .card img.loaded { opacity: 1; }
  .badge {
    position: absolute; left: 8px; bottom: 8px; display: flex; align-items: center; gap: 4px;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(8px); border-radius: 999px;
    padding: 3px 9px; color: #fff; font-size: 0.72rem; font-weight: 600;
  }
  .date { position: absolute; right: 8px; bottom: 8px; color: rgba(255,255,255,0.85); font-size: 0.66rem;
    background: rgba(0,0,0,0.45); backdrop-filter: blur(8px); border-radius: 999px; padding: 3px 8px; }
  .empty { text-align: center; color: #6e6e73; padding: 5rem 1rem; line-height: 1.7; }
</style>
</head>
<body>
  <a class="back" href="/" title="回到今天">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
  </a>
  <h1>❤️ 全家最爱</h1>
  <div class="sub">被表态最多的照片</div>
  <div class="grid" id="grid"></div>
  <div class="empty" id="empty" style="display:none">还没有人表态过<br>去照片里点一个 ❤️ 吧</div>
<script>
  fetch('/api/top-loved').then(function (r) { return r.json(); }).then(function (data) {
    var photos = data.photos || [];
    if (!photos.length) { document.getElementById('empty').style.display = 'block'; return; }
    document.getElementById('grid').innerHTML = photos.map(function (p) {
      var thumb = p.url.replace('/img/', '/thumb/') + '?w=400&h=400&q=75&fit=cover';
      var dateTxt = p.year + '/' + p.month + '/' + p.day;
      var href = '/?month=' + p.month + '&day=' + p.day;
      return '<a class="card" href="' + href + '">' +
        '<img src="' + thumb.replace(/"/g, '&quot;') + '" loading="lazy" onload="this.classList.add(\\'loaded\\')" />' +
        '<span class="badge">❤️ ' + p.total + '</span><span class="date">' + dateTxt + '</span></a>';
    }).join('');
  });
</script>
</body>
</html>`;

// ── PWA 应用图标 ──────────────────────────────────────────────────────────────
// 用全库 AI 评分最高的照片裁成方形做安装图标（PWA manifest + apple-touch-icon），
// 每个尺寸的成品缓存在 PREVIEWS，边缘缓存一天
async function handleAppIcon(request, env, url) {
  // 64 给浏览器标签页 favicon，180 给 apple-touch-icon，192/512 给 PWA manifest
  const allowed = [64, 180, 192, 512];
  const size = allowed.includes(Number(url.searchParams.get("size"))) ? Number(url.searchParams.get("size")) : 512;

  const cache = caches.default;
  const cacheKey = new Request(`${SITE_ORIGIN}/app-icon?size=${size}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const row = await env.DB.prepare(
    `SELECT pi.key AS key FROM photos_index pi
     JOIN photo_scores ps ON ps.key = pi.key
     WHERE pi.type = 'image' AND ps.score IS NOT NULL
     ORDER BY ps.score DESC LIMIT 1`
  ).first();
  if (!row) return new Response("Not Found", { status: 404 });

  const iconKey = `icon/${size}/${row.key.replace(/\.[^.]+$/, "")}.jpg`;
  let buf;
  const existing = await env.PREVIEWS.get(iconKey);
  if (existing) {
    buf = await existing.arrayBuffer();
  } else {
    const object = await env.PHOTOS.get(row.key);
    if (!object) return new Response("Not Found", { status: 404 });
    try {
      const transformed = await env.IMAGES.input(object.body)
        .transform({ width: size, height: size, fit: "cover" })
        .output({ format: "image/jpeg", quality: 85 });
      buf = await transformed.response().arrayBuffer();
    } catch {
      return new Response("Unprocessable", { status: 422 });
    }
    await env.PREVIEWS.put(iconKey, buf, {
      httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
    });
  }

  const resp = new Response(buf, {
    headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
  });
  await cache.put(cacheKey, resp.clone());
  return resp;
}

// 首页 HTML 注入 og meta。month/day 都是校验过的两位数字，title 只含数字和汉字，
// 不存在注入面
function injectOgTags(assetResp, url) {
  const today = bjToday();
  const month = /^\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : today.month;
  const day = /^\d{2}$/.test(url.searchParams.get("day") || "") ? url.searchParams.get("day") : today.day;
  const title = `${parseInt(month)}月${parseInt(day)}日，那些年的此刻`;
  const tags =
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="那年今日">` +
    `<meta property="og:title" content="${title}">` +
    `<meta property="og:description" content="横跨那些年头的家庭照片回忆">` +
    `<meta property="og:url" content="${SITE_ORIGIN}/?month=${month}&day=${day}">` +
    `<meta property="og:image" content="${SITE_ORIGIN}/og-image?month=${month}&day=${day}">` +
    `<meta property="og:image:width" content="1200">` +
    `<meta property="og:image:height" content="630">` +
    `<meta name="twitter:card" content="summary_large_image">`;
  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(tags, { html: true });
      },
    })
    .transform(assetResp);
}
// ─────────────────────────────────────────────────────────────────────────────

// 把 Workflow 登记的"今天新照片"聚合成一条 Telegram 消息推送出去。
// 每次 Cron（10 分钟）跑一趟：有多少发多少（图最多带 10 张，条数说总量），
// 发送成功才把队列里对应的 key 删掉，失败留着下一趟重试
async function flushPendingNotifications(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const { results } = await env.DB.prepare(
    "SELECT key FROM meta WHERE key LIKE 'notify:%' LIMIT 50"
  ).all();
  if (!results.length) return;
  const metaKeys = results.map((r) => r.key);
  const photoKeys = metaKeys.map((k) => k.slice("notify:".length));

  // 生成直链，最多带 10 张；单张生成失败跳过（key 照删，坏图不卡队列）
  const media = [];
  for (const k of photoKeys) {
    if (media.length >= 10) break;
    const photoUrl = await tgPhotoUrl(env, k);
    if (photoUrl) media.push({ type: "photo", media: photoUrl });
  }

  const { month, day } = bjToday();
  const caption = `📸 今天新增 ${photoKeys.length} 张照片\n🔗 ${SITE_ORIGIN}/?month=${month}&day=${day}`;
  const tgBase = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const chatIds = tgChatIds(env);

  let anyFailed = false;
  for (const chatId of chatIds) {
    let resp;
    if (media.length === 0) {
      // 全部生成失败——退化为纯文本，至少让人知道有新照片
      resp = await fetch(`${tgBase}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: caption }),
      });
    } else if (media.length === 1) {
      resp = await fetch(`${tgBase}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, photo: media[0].media, caption }),
      });
    } else {
      const mediaWithCaption = media.map((m, i) => (i === 0 ? { ...m, caption } : m));
      resp = await fetch(`${tgBase}/sendMediaGroup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, media: mediaWithCaption }),
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`flushPendingNotifications: Telegram API error for chat ${chatId}`, resp.status, errText);
      // 5xx / 429 是临时性错误，保留队列下趟重试；400 / 403 / 404 是永久性错误，不阻塞队列清理
      if (resp.status >= 500 || resp.status === 429) {
        anyFailed = true;
      }
    }
  }

  if (anyFailed) return; // 有临时性失败，保留队列下一趟 Cron 重试
  const placeholders = metaKeys.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM meta WHERE key IN (${placeholders})`).bind(...metaKeys).run();
  console.log(`flushPendingNotifications: notified ${photoKeys.length} new photos`);
}

async function runBackgroundMaintenance(env) {
  const BATCH_SIZE = 10;

  // 今天新照片的聚合推送放在最前面——很轻（多数时候队列是空的，一条 SELECT 就返回），
  // 不跟后面的回填/打分抢内存
  try {
    await flushPendingNotifications(env);
  } catch (err) {
    console.error("flushPendingNotifications failed", err);
  }

  // 回填（listAll 扫全量 ~16000 张建一个大数组）跟 HEIC 解码（单张就能占几十 MB 原始像素）
  // 是这个函数里两个最吃内存的环节，干万不能凑到同一次调用里——上一次就是因为两个撞一起
  // 又把 Cron 炸了（exceededMemory）。按当前分钟单双轮流跑，保证它俩永远不同时出现
  const doBackfillThisTick = new Date().getMinutes() % 20 < 10;
  if (doBackfillThisTick) {
    // 自动把存量照片慢慢补进 photos_index，不用再手动一次次点 /admin/backfill-photos-index。
    // 回填全部完成后写个时间戳标记：之后每天只核对一次，不再每 20 分钟白白 listAll 扫一遍
    // 全桶 + 全表 SELECT 来发现"没活干"（新上传的照片走 queue 增量维护，不依赖这里）
    const doneAt = Date.parse((await env.KV.get("backfill_done_at")) || "");
    if (!(Date.now() - doneAt < 24 * 3600 * 1000)) {
      const res = await backfillPhotosIndexBatch(env, 300);
      if (res.remaining === 0) {
        await env.KV.put("backfill_done_at", new Date().toISOString());
      } else {
        // 又出现了没索引的文件（比如 R2 事件丢了）——清掉标记，恢复每 20 分钟一批的追赶节奏
        await env.KV.delete("backfill_done_at");
      }
    }
  } else {
    // 单双分钟的另一半：一次性重算存量索引行的日期（修正"路径月+文件名日"时期写错的行，
    // 见 reindexPhotoDatesBatch）。进度存 KV，每趟一批，扫完整张表写完成标记后永久跳过。
    // 批内 EXIF 读取是串行的（单个 256KB 缓冲），不会和回填的 listAll 大数组撞内存
    const reindexDone = await env.KV.get("reindex_dates_done_at");
    if (!reindexDone) {
      const offset = Number((await env.KV.get("reindex_dates_offset")) || 0);
      const res = await reindexPhotoDatesBatch(env, 200, offset);
      if (res.fixed > 0) {
        console.log(`reindexPhotoDates: offset=${offset} fixed=${res.fixed}`,
          JSON.stringify(res.changes.slice(0, 5)));
      }
      if (res.nextOffset == null) {
        await env.KV.put("reindex_dates_done_at", new Date().toISOString());
        await env.KV.delete("reindex_dates_offset");
        console.log("reindexPhotoDates: 全表扫描完成");
      } else {
        await env.KV.put("reindex_dates_offset", String(res.nextOffset));
      }
    }
  }

  // 之前这里用 listAll() 扫一遍整个 R2 桶 + matchPhotosForDay() 对每个年份再扫一遍、
  // 并发读一批 EXIF——8000+ 张照片之后这套组合在 Cron 里稳定触发 exceededMemory，
  // 整个 Cron 任务直接被杀掉，打分/查地点/HEIC 转码全都没跑成。改成查 photos_index 表，
  // 候选池准不准全看回填有没有跑完——没跑完之前只是子集，跑完之后这里的"今天优先"就是完整覆盖了
  // （matchPhotosForDay 现在也改查这张表了，两边口径一致）
  // 北京时间的"今天"——Workers 跑在 UTC，直接用 new Date() 的话北京 0 点到 8 点之间
  // 算出来的是昨天，早上拍的照片要到 8 点后才能进优先打分/HEIC 转码队列；
  // 推送和 Workflow 的 queue-notify 一直用的都是 bjToday()，这里对齐口径
  const realToday = bjToday();
  const lastViewed = await getLastViewedDay(env);

  // 优先级最高的永远是服务器的"今天"——手机刚拍完传上来的照片不该因为有人在翻看某个历史日期
  // 就一直排不上号；"最近在看的那一天"（可能是某个历史日期）也给一份优先，体验上更贴合
  const priorityDays = [realToday];
  if (lastViewed && (lastViewed.month !== realToday.month || lastViewed.day !== realToday.day)) {
    priorityDays.push(lastViewed);
  }

  // 原来这里把整张 photos_index + photo_scores（含 raw_response 大文本）+ photo_places
  // 全部读进内存再逐个过滤，内存随库存线性涨。改成 LEFT JOIN 在 SQL 侧直接筛出
  // "还没打分/还没查地点"的 key（优先日期先查、全库补足），每次只拿一小批候选进内存
  const candidatesToCheck = await collectCandidates(env, findUnscoredKeys, priorityDays, BATCH_SIZE * 3);
  // 跟队列消费者那边一样：没预览图的 HEIC 不在这里打分（打分要现场解码，好几张堆在同一次
  // Cron 调用里很容易把内存吃爆）。只检查这一小批候选（head() 很便宜），凑够一批就够了
  const checked = await mapWithConcurrency(candidatesToCheck, 4, async (key) => {
    if (/\.heic$/i.test(key) && !(await findHeicPreviewKey(env, key))) return null;
    return key;
  });
  const unscored = checked.filter(Boolean).slice(0, BATCH_SIZE);
  if (unscored.length > 0) await scoreKeys(env, unscored);

  // 循环查地点直到全部完成或时间预算耗尽（每次 Cron 最多跑 24 秒用于地点查询）。
  // 每张照片：R2 读 EXIF ~100ms + Mapbox API ~200ms，24s 内可处理约 80 张，
  // 相比之前每次只处理 10 张快 8 倍；积压清完后每次 collectCandidates 返回空直接退出，几乎没有开销。
  const locateDeadline = Date.now() + 24000;
  while (Date.now() < locateDeadline) {
    const unlocated = await collectCandidates(env, findUnlocatedKeys, priorityDays, BATCH_SIZE);
    if (unlocated.length === 0) break;
    await enrichLocations(env, unlocated);
  }

  // HEIC 预览图只转"今天"（服务器真实今天）拍的——不像打分/查地点那样还顺带覆盖"最近浏览日期"
  // 或者存量库的其他照片。解码一张全尺寸 HEIC 到原始像素再编码成 JPEG，内存开销比打分/查地点都
  // 重得多（一张 12MP 照片解码出来的原始像素就有几十 MB），范围卡得越窄，内存/CPU 风险越小
  const HEIC_BATCH_SIZE = 1;
  if (!doBackfillThisTick) {
    const { results: todayHeicRows } = await env.DB.prepare(
      // SQLite 的 LIKE 对 ASCII 字母默认就不分大小写，'%.heic' 能匹配到 .HEIC/.heic 两种大小写
      "SELECT key FROM photos_index WHERE month = ? AND day = ? AND key LIKE '%.heic'"
    )
      .bind(realToday.month, realToday.day)
      .all();
    const heicToday = todayHeicRows.map((r) => r.key);
    if (heicToday.length > 0) {
      await convertHeicBatch(env, heicToday, HEIC_BATCH_SIZE);
    }
  }
}

// Live Photo 配对：iPhone 的 Live Photo 在 R2 里是两个独立文件——同目录、文件名（去掉
// 扩展名）完全相同的一张 HEIC/JPEG + 一段 MOV，例如 IMG_1234.HEIC 配 IMG_1234.MOV。
// 把同一批文件（已经按 IMAGE_EXT/VIDEO_EXT 过滤过）按"完整 key 去扩展名"分组，
// 配对成功的合并成一条 type: 'live' 记录（带 url 静态图 + videoUrl 配对视频），
// 没配对到的图片/视频各自按原来的 image/video 类型展示，不受影响
function pairLivePhotos(objs, year) {
  const byBase = new Map();
  for (const obj of objs) {
    // 分组键必须带目录（完整 key 去扩展名）：iPhone 的 IMG_XXXX 序号是循环重用的，
    // 只按文件名分组时，同一天命中的两个不同目录的同名文件会互相顶掉（两张图只剩一张）
    // 或把 A 目录的照片错配上 B 目录的视频当成假 Live Photo
    const base = obj.key.replace(/\.[^.]+$/, "");
    const slot = byBase.get(base) || {};
    if (VIDEO_EXT.test(obj.key)) slot.video = obj;
    else slot.image = obj;
    byBase.set(base, slot);
  }

  const entries = [];
  for (const { image, video } of byBase.values()) {
    if (image && video) {
      entries.push({
        key: image.key,
        url: `/img/${encodeURIComponent(image.key)}`,
        videoUrl: `/img/${encodeURIComponent(video.key)}`,
        type: "live",
        size: image.size,
        uploaded: image.uploaded,
        year,
      });
    } else if (image || video) {
      const obj = image || video;
      entries.push({
        key: obj.key,
        url: `/img/${encodeURIComponent(obj.key)}`,
        type: video ? "video" : "image",
        size: obj.size,
        uploaded: obj.uploaded,
        year,
      });
    }
  }
  return entries;
}

// 限制并发数跑一批异步任务——不限制的话，一个月份下几百张没带日期文件名的照片会同时发出几百个
// EXIF 范围读请求，每个都在内存里挂着一份响应 buffer，年头一多很容易把 Worker 的内存配额跑爆
// （Cron 那次 exceededMemory 就是栽在这上面）
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── 农历转换（1900–2049）─────────────────────────────────────────────────────
// 经典压缩表：每年一个整数，低 4 位 = 闰月月份（0 为无闰），bit4~bit15 = 十二个月大小月
// （1 大月 30 天 / 0 小月 29 天），bit16 = 闰月大小。基准：1900-01-31 为庚子年正月初一
const LUNAR_INFO = [
  0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,//1900-1909
  0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,//1910-1919
  0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,//1920-1929
  0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,//1930-1939
  0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,//1940-1949
  0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,//1950-1959
  0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,//1960-1969
  0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b5a0,0x195a6,//1970-1979
  0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,//1980-1989
  0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x05ac0,0x0ab60,0x096d5,0x092e0,//1990-1999
  0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,//2000-2009
  0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,//2010-2019
  0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,//2020-2029
  0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,//2030-2039
  0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,//2040-2049
];
const LUNAR_EPOCH_UTC = Date.UTC(1900, 0, 31);
function _leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }
function _leapDays(y) { return _leapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0; }
function _monthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
function _lunarYearDays(y) {
  let sum = 348; // 12 × 29
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
  return sum + _leapDays(y);
}

// 公历 → 农历，超出表范围返回 null
function solarToLunar(sy, sm, sd) {
  let offset = Math.floor((Date.UTC(sy, sm - 1, sd) - LUNAR_EPOCH_UTC) / 86400000);
  if (offset < 0) return null;
  let ly = 1900;
  for (; ly < 2050; ly++) {
    const yd = _lunarYearDays(ly);
    if (offset < yd) break;
    offset -= yd;
  }
  if (ly >= 2050) return null;
  const leap = _leapMonth(ly);
  let isLeap = false;
  let lm = 1;
  while (lm <= 12) {
    let days;
    if (leap > 0 && lm === leap + 1 && !isLeap) {
      // 闰月排在第 leap 个月之后，月份号不前进
      isLeap = true;
      days = _leapDays(ly);
      lm--;
    } else {
      days = _monthDays(ly, lm);
      isLeap = false;
    }
    if (offset < days) break;
    offset -= days;
    lm++;
  }
  return { year: ly, month: lm, day: offset + 1, isLeap };
}

// 农历 → 公历；该年没有这个闰月/这一天（如某年腊月没有三十）时返回 null
function lunarToSolar(ly, lm, ld, isLeapMonth) {
  if (ly < 1900 || ly >= 2050) return null;
  const leap = _leapMonth(ly);
  if (isLeapMonth && leap !== lm) isLeapMonth = false;
  const dm = isLeapMonth ? _leapDays(ly) : _monthDays(ly, lm);
  if (ld > dm) return null;
  let offset = 0;
  for (let y = 1900; y < ly; y++) offset += _lunarYearDays(y);
  for (let m = 1; m < lm; m++) {
    offset += _monthDays(ly, m);
    if (leap === m) offset += _leapDays(ly);
  }
  if (isLeapMonth) offset += _monthDays(ly, lm);
  offset += ld - 1;
  const date = new Date(LUNAR_EPOCH_UTC + offset * 86400000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const LUNAR_MONTH_NAMES = ['正','二','三','四','五','六','七','八','九','十','冬','腊'];
function lunarDayName(d) {
  if (d === 10) return '初十';
  if (d === 20) return '二十';
  if (d === 30) return '三十';
  const tens = ['初','十','廿','三'];
  const ones = ['十','一','二','三','四','五','六','七','八','九'];
  return tens[Math.floor(d / 10)] + ones[d % 10];
}
function lunarLabel(l) {
  return `${l.isLeap ? '闰' : ''}${LUNAR_MONTH_NAMES[l.month - 1]}月${lunarDayName(l.day)}`;
}

// 农历同日匹配：算出"当前北京年份的这个公历日"对应的农历日，再把库里每个年份的
// 同一农历日反推回公历，捞出那些天拍的照片（排除公历同日已经出现过的，避免重复）
async function matchLunarPhotos(env, month, day, excludeKeys) {
  const bjYear = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCFullYear();
  const lunar = solarToLunar(bjYear, parseInt(month), parseInt(day));
  if (!lunar) return null;

  const { results: yearRows } = await env.DB.prepare(
    "SELECT DISTINCT year FROM photos_index ORDER BY year DESC"
  ).all();

  // 公历年 Y 里的农历 (lm, ld)：多数落在农历年 Y，但农历冬月/腊月常落到公历 Y+1 年初，
  // 所以先试农历年 Y，落不进公历 Y 再试农历年 Y-1
  const triples = [];
  for (const { year } of yearRows) {
    const gy = Number(year);
    if (!Number.isFinite(gy)) continue;
    let solar = lunarToSolar(gy, lunar.month, lunar.day, lunar.isLeap);
    if (!solar || solar.year !== gy) {
      solar = lunarToSolar(gy - 1, lunar.month, lunar.day, lunar.isLeap);
    }
    if (solar && solar.year === gy) {
      triples.push({ year, month: String(solar.month).padStart(2, "0"), day: String(solar.day).padStart(2, "0") });
    }
  }
  if (!triples.length) return { label: lunarLabel(lunar), years: [] };

  const conds = triples.map(() => "(year = ? AND month = ? AND day = ?)").join(" OR ");
  const binds = triples.flatMap((t) => [t.year, t.month, t.day]);
  const { results } = await env.DB.prepare(
    `SELECT key, year, month, day, size, uploaded FROM photos_index WHERE ${conds}`
  ).bind(...binds).all();

  const byYearRows = new Map();
  for (const row of results) {
    if (!byYearRows.has(row.year)) byYearRows.set(row.year, []);
    byYearRows.get(row.year).push(row);
  }
  const years = [...byYearRows.entries()]
    .map(([year, rows]) => {
      const solarDate = triples.find((t) => t.year === year);
      const photos = pairLivePhotos(rows, year)
        .filter((p) => !excludeKeys.has(p.key))
        .sort((a, b) => a.key.localeCompare(b.key));
      return photos.length > 0
        ? { year, month: solarDate.month, day: solarDate.day, photos }
        : null;
    })
    .filter(Boolean);
  years.sort((a, b) => Number(b.year) - Number(a.year));
  return { label: lunarLabel(lunar), years };
}

async function matchPhotosForDay(env, month, day) {
  // photos_index 在写入时就用跟这里完全相同的规则算好了拍摄日（文件名带日期直接解析，没带的
  // 走 EXIF/上传时间兜底，见 computePhotoMeta），所以这里直接按索引查，不用再现场 list() 扫 R2 +
  // 对每个没带日期的文件单独读一次 EXIF——之前这套组合是"切日期卡顿/首次加载等好几秒"的根源
  const { results } = await env.DB.prepare(
    "SELECT key, year, size, uploaded FROM photos_index WHERE month = ? AND day = ?"
  )
    .bind(month, day)
    .all();

  const byYearRows = new Map();
  for (const row of results) {
    if (!byYearRows.has(row.year)) byYearRows.set(row.year, []);
    byYearRows.get(row.year).push(row);
  }

  const byYear = [...byYearRows.entries()]
    .map(([year, rows]) => {
      const photos = pairLivePhotos(rows, year)
        // 按文件名排一下序，同一年的照片别再乱序出现
        .sort((a, b) => a.key.localeCompare(b.key));
      return photos.length > 0 ? { year, month, day, photos } : null;
    })
    .filter(Boolean);
  byYear.sort((a, b) => Number(b.year) - Number(a.year));
  return byYear;
}

// ---------- API: 列出"那年今日"的照片 ----------
async function handleMemories(request, env, url, ctx) {
  // month/day 必须由前端按本地时间传入，避免 Worker 跑在 UTC 导致跨时区算错"今天"
  const month = url.searchParams.get("month");
  const day = url.searchParams.get("day");
  if (!/^\d{2}$/.test(month || "") || !/^\d{2}$/.test(day || "")) {
    return new Response(JSON.stringify({ error: "month/day required, format MM/DD" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // 同一天会被反复访问，用边缘缓存挡住重复请求，避免每次访问都重新查一遍 D1
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cachedResp = await cache.match(cacheKey);
  if (cachedResp) return cachedResp;

  const includeLunar = url.searchParams.get("lunar") === "1";

  const matchedByYear = await matchPhotosForDay(env, month, day);
  // 只查这一天命中的那几十张照片，不用把整张 photo_scores/photo_places 表都读出来——
  // 这两张表是跟着整个库的年头一起涨的，按 key 过滤之后查询成本只跟"今天"的照片数挂钩
  const matchedKeys = matchedByYear.flatMap((y) => y.photos.map((p) => p.key));

  // 农历同日默认不查、不展示；只有前端开关传 lunar=1 时才计算，避免默认视图额外查库。
  // 出错不影响主内容（label 照常返回，段落为空）
  let lunar = null;
  if (includeLunar) {
    try {
      lunar = await matchLunarPhotos(env, month, day, new Set(matchedKeys));
    } catch (err) {
      console.error("matchLunarPhotos failed", err);
    }
  }
  const lunarKeys = lunar ? lunar.years.flatMap((y) => y.photos.map((p) => p.key)) : [];

  // AI 离线打分的结果（没跑过 /admin/score-photos 或某张图还没轮到时，对应分数就是 undefined）
  const scores = await loadScoresForKeys(env, [...matchedKeys, ...lunarKeys]);
  // 拍摄地点（反向地理编码结果），同样是离线缓存，没查过的是 undefined，查过但没 GPS 信息的是空字符串
  const places = await loadPlacesForKeys(env, [...matchedKeys, ...lunarKeys]);

  const enrich = (y) => ({
    ...y,
    photos: y.photos.map((p) => {
      const { score, hasFace, caption } = scoreInfoOf(scores[p.key]);
      return { ...p, score, hasFace, caption, place: placeNameOf(places[p.key]) };
    }),
  });
  const results = matchedByYear.map(enrich);
  if (lunar) lunar = { ...lunar, years: lunar.years.map(enrich) };

  const response = new Response(JSON.stringify({ month, day, years: results, lunar }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=1800",
    },
  });
  await cache.put(cacheKey, response.clone());

  // AI 打分和查地点不在这里自动触发了——这个接口本来就要为没有日期文件名的照片逐个读 EXIF，
  // 子请求数（R2 读取 + Mapbox 调用）叠加起来很容易超过 Workers 单次调用的子请求上限导致整页挂掉。
  // 改成用 Cron 定时任务在后台独立跑（见下面的 scheduled()），不占用用户访问时的子请求预算。
  // 这里只是顺手记一下"最近在看哪一天"（只多一次很轻的写入），让 Cron 任务知道该优先处理哪天的照片，
  // 不一定是服务器的"今天"——比如翻日历去看了某个历史日期，后台也会跟着优先处理那一天
  if (ctx) {
    ctx.waitUntil(setLastViewedDay(env, month, day));

    // 顺手把这一天匹配到的 HEIC 转一小批预览图，不用等 Cron 最多 10 分钟才轮到——
    // 放在 waitUntil 里，不占用本次响应的等待时间；batch 给得很小，避免和上面的 EXIF 读取叠加起来撞子请求上限
    const heicKeys = matchedByYear.flatMap((y) => y.photos).filter((p) => (p.type === "image" || p.type === "live") && /\.heic$/i.test(p.key)).map((p) => p.key);
    if (heicKeys.length > 0) {
      ctx.waitUntil(convertHeicBatch(env, heicKeys, 3));
    }
  }

  return response;
}

// 列出某 prefix 下所有对象（自动翻页）
async function listAll(bucket, prefix) {
  const out = [];
  let cursor;
  do {
    const listing = await bucket.list({ prefix, cursor });
    out.push(...listing.objects);
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return out;
}

// ---------- photos_index：R2 Event Notification -> Queue 维护的索引表，
// matchPhotosForDay 靠这张表按 month/day 查，不用每次都 list() 扫一遍 R2 ----------

// key 形如 Photos/MobileBackup/iPhone/{year}/{month}/{文件名}，年月直接从路径解析
function yearMonthFromKey(key) {
  const m = key.match(new RegExp(`^${BASE_PREFIX.replace(/\//g, "\\/")}(\\d{4})\\/(\\d{2})\\/`));
  return m ? { year: m[1], month: m[2] } : null;
}

// 算出一张照片/视频要写进 photos_index 的那一行；不是照片/视频，或者路径不符合预期结构就返回 null（不索引）
async function computePhotoMeta(env, key, knownObj) {
  if (!IMAGE_EXT.test(key) && !VIDEO_EXT.test(key)) return null;
  const ym = yearMonthFromKey(key);
  if (!ym) return null;

  let size = knownObj && knownObj.size;
  let uploaded = knownObj && knownObj.uploaded;
  if (size == null || uploaded == null) {
    const head = await env.PHOTOS.head(key);
    if (!head) return null;
    size = head.size;
    uploaded = head.uploaded ? new Date(head.uploaded).toISOString() : null;
  } else if (uploaded instanceof Date) {
    uploaded = uploaded.toISOString();
  }

  // 年/月/日必须整体来自同一个拍摄日期源，不能路径出月、文件名出日地拼——
  // iPhone 备份是按"备份时间"落目录的（.../{备份年}/{备份月}/），6/14 拍的照片 7 月才备份
  // 就会躺在 07/ 目录里，之前用路径月 + 文件名日拼出 7月14日 这种不存在的拍摄日
  const basename = key.split("/").pop();
  let year = null, month = null, day = null;
  const dateMatch = basename.match(/((?:19|20)\d{2})(\d{2})(\d{2})/); // YYYYMMDD
  if (dateMatch && Number(dateMatch[2]) >= 1 && Number(dateMatch[2]) <= 12 && Number(dateMatch[3]) >= 1 && Number(dateMatch[3]) <= 31) {
    year = dateMatch[1];
    month = dateMatch[2];
    day = dateMatch[3];
  } else {
    // 文件名没带日期（IMG_1017.JPG 这类纯序号）：EXIF 优先，没有就用 R2 上传时间
    const md = await getCapturedMonthDay(env.PHOTOS, key);
    if (md) {
      year = md.year || ym.year; // 早期缓存条目没有 year，退回路径年份
      month = md.month;
      day = md.day;
    }
  }
  if (!month || !day) return null; // 实在拿不到拍摄日，先不索引——下次事件重投或者再跑一次回填脚本还能补上

  return {
    key,
    type: VIDEO_EXT.test(key) ? "video" : "image",
    year,
    month,
    day,
    size,
    uploaded,
  };
}

async function upsertPhotoIndex(env, meta) {
  await env.DB.prepare(
    "INSERT INTO photos_index (key, type, year, month, day, size, uploaded, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET type=excluded.type, year=excluded.year, month=excluded.month, " +
      "day=excluded.day, size=excluded.size, uploaded=excluded.uploaded, updated_at=excluded.updated_at"
  )
    .bind(meta.key, meta.type, meta.year, meta.month, meta.day, meta.size, meta.uploaded, new Date().toISOString())
    .run();
}

async function indexPhoto(env, key, knownObj) {
  const meta = await computePhotoMeta(env, key, knownObj);
  if (meta) await upsertPhotoIndex(env, meta);
  return meta;
}

// 原图从 R2 删掉之后，photos_index/打分/查地点这几张表里的记录也跟着删，不然"那年今日"
// 还会接着展示一张早就不存在的照片（/img/ 代理 404，缩略图裂图）。返回被删掉那条索引记录的
// month/day（没有就返回 null），方便调用方知道该清哪一天的页面缓存
async function removePhotoIndex(env, key) {
  const existing = await env.DB.prepare("SELECT month, day FROM photos_index WHERE key = ?").bind(key).first();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM photos_index WHERE key = ?").bind(key),
    env.DB.prepare("DELETE FROM photo_scores WHERE key = ?").bind(key),
    env.DB.prepare("DELETE FROM photo_places WHERE key = ?").bind(key),
  ]);

  // HEIC 的预览图存在另一个桶（PREVIEWS），原图删了配套的预览图也要删，不然 R2 里留一份没人会再用到的孤儿文件
  if (/\.heic$/i.test(key)) {
    const previewKey = await findHeicPreviewKey(env, key);
    if (previewKey) await env.PREVIEWS.delete(previewKey);
  }

  return existing ? { month: existing.month, day: existing.day } : null;
}

// 获取文件的拍摄日期（年/月/日）。JPEG/HEIC 读 EXIF，其他格式回退用 R2 上传时间近似。
// 早期缓存条目没有 year 字段，调用方要兜底（用路径年份）
// 用 Workers Cache API 缓存结果，避免无日期文件名的文件每次请求都重新读取/解析
async function getCapturedMonthDay(bucket, key) {
  const cache = caches.default;
  const cacheKey = new Request(`https://memories.internal/exif-cache/${encodeURIComponent(key)}`);

  const cached = await cache.match(cacheKey);
  if (cached) {
    const r = await cached.json();
    // 老 bug 缓存过"只有 GPS、没有日期"的残缺条目（见下），这种当缓存未命中重算
    if (r && r.month && r.day) return r;
  }

  let result = null;
  if (/\.jpe?g$/i.test(key)) {
    result = await readJpegExifDate(bucket, key);
  } else if (/\.heic$/i.test(key)) {
    // HEIC 容器结构跟 JPEG 完全不同，解析失败就静默放弃，走下面的上传时间兜底
    try {
      result = await readHeicExifDate(bucket, key);
    } catch {
      result = null;
    }
  }
  // 注意不能只判 !result：EXIF 里有 GPS 但没有拍摄时间的照片，parseExifTiff 返回
  // 只带 {lat, lon} 的真值对象——之前这里因此跳过上传时间兜底，照片拿不到 month/day
  // 就永远进不了 photos_index（页面上完全不可见），且残缺结果还被缓存一年
  if (!result || !result.month || !result.day) {
    const head = await bucket.head(key);
    if (head && head.uploaded) {
      const d = new Date(head.uploaded);
      result = {
        ...(result || {}),
        year: String(d.getFullYear()),
        month: String(d.getMonth() + 1).padStart(2, "0"),
        day: String(d.getDate()).padStart(2, "0"),
      };
    }
  }

  if (result) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json", "cache-control": "max-age=31536000, immutable" },
      })
    );
  }
  return result;
}

// 只取文件头部 128KB 解析 JPEG 的 EXIF DateTimeOriginal，避免下载整个文件
async function readJpegExifDate(bucket, key) {
  const obj = await bucket.get(key, { range: { offset: 0, length: 131072 } });
  if (!obj) return null;
  const buf = new Uint8Array(await obj.arrayBuffer());
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // 不是 JPEG

  let offset = 2;
  while (offset < buf.length - 4) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const size = (buf[offset + 2] << 8) | buf[offset + 3];
    if (marker === 0xe1) {
      const segStart = offset + 4;
      if (
        buf[segStart] === 0x45 && buf[segStart + 1] === 0x78 &&
        buf[segStart + 2] === 0x69 && buf[segStart + 3] === 0x66
      ) {
        return parseExifTiff(buf, segStart + 6); // 跳过 "Exif\0\0"
      }
    }
    if (marker === 0xda) break; // 到图像数据，EXIF 不会在后面
    offset += 2 + size;
  }
  return null;
}

// ---------- HEIC：EXIF 藏在 ISOBMFF 容器的 meta box 里，结构跟 JPEG 完全不同 ----------
// 大致路径：meta box → iinf box 里找类型为 "Exif" 的 item，拿到它的 item_ID
//          → 再去 iloc box 里按 item_ID 查出这段数据在文件里的偏移量/长度 → 单独读那一段
// meta/iinf/iloc 通常都在文件靠前的位置，先读前 256KB 找它们；EXIF 数据本体可能在后面的 mdat 里，按偏移单独取
async function readHeicExifDate(bucket, key) {
  const headObj = await bucket.get(key, { range: { offset: 0, length: 262144 } });
  if (!headObj) return null;
  const buf = new Uint8Array(await headObj.arrayBuffer());

  const metaBox = findIsoBox(buf, 0, buf.length, "meta");
  if (!metaBox) return null;
  const metaContentStart = metaBox.contentStart + 4; // meta 是 full box，跳过 version(1)+flags(3)

  const iinfBox = findIsoBox(buf, metaContentStart, metaBox.contentEnd, "iinf");
  const ilocBox = findIsoBox(buf, metaContentStart, metaBox.contentEnd, "iloc");
  if (!iinfBox || !ilocBox) return null;

  const exifItemId = findExifItemId(buf, iinfBox.contentStart, iinfBox.contentEnd);
  if (exifItemId == null) return null;

  const extent = findIlocExtent(buf, ilocBox.contentStart, ilocBox.contentEnd, exifItemId);
  if (!extent || extent.length < 4) return null;

  // EXIF item 数据本体可能不在前 256KB 里，单独按偏移取那一小段
  const exifObj = await bucket.get(key, { range: { offset: extent.offset, length: extent.length } });
  if (!exifObj) return null;
  const exifBuf = new Uint8Array(await exifObj.arrayBuffer());

  // 前 4 字节是到 TIFF 头的偏移量（通常后面紧跟着 "Exif\0\0" 之类的占位），跳过去之后就是标准 TIFF 结构，
  // 直接复用 JPEG 那边已经写好的 parseExifTiff
  const tiffHeaderOffset = (exifBuf[0] << 24) | (exifBuf[1] << 16) | (exifBuf[2] << 8) | exifBuf[3];
  return parseExifTiff(exifBuf, 4 + tiffHeaderOffset);
}

// 在 [start, end) 范围内找第一个匹配 type 的 ISOBMFF box（只看同级，不递归），
// 返回 box 内容区间，方便调用方继续往下钻（比如先找 meta 再在它内部找 iinf）
function findIsoBox(buf, start, end, type) {
  const typeBytes = Array.from(type, (c) => c.charCodeAt(0));
  let offset = start;
  while (offset + 8 <= end) {
    let size = ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
    if (size === 1) return null; // 64 位大尺寸 box，meta/iinf/iloc 基本不会用到，遇到了就放弃
    if (size === 0) size = end - offset; // 0 表示一直延伸到容器结尾
    if (size < 8 || offset + size > end) return null;
    const matches = typeBytes.every((b, i) => buf[offset + 4 + i] === b);
    if (matches) {
      return { start: offset, size, contentStart: offset + 8, contentEnd: offset + size };
    }
    offset += size;
  }
  return null;
}

// 解析 iinf box 内容，找类型为 "Exif" 的 item，返回它的 item_ID
function findExifItemId(buf, start, end) {
  if (start + 4 > end) return null;
  const version = buf[start];
  let cursor = start + 4; // 跳过 version(1)+flags(3)
  let entryCount;
  if (version === 0) {
    entryCount = (buf[cursor] << 8) | buf[cursor + 1];
    cursor += 2;
  } else {
    entryCount = ((buf[cursor] << 24) | (buf[cursor + 1] << 16) | (buf[cursor + 2] << 8) | buf[cursor + 3]) >>> 0;
    cursor += 4;
  }

  for (let i = 0; i < entryCount && cursor + 8 <= end; i++) {
    const size = ((buf[cursor] << 24) | (buf[cursor + 1] << 16) | (buf[cursor + 2] << 8) | buf[cursor + 3]) >>> 0;
    if (size < 8) break;
    const infeVersion = buf[cursor + 8]; // box 头(8) 之后是 version(1)+flags(3)
    let p = cursor + 8 + 4;
    let itemId = null;
    let itemType = null;
    if (infeVersion === 2) {
      itemId = (buf[p] << 8) | buf[p + 1];
      p += 4; // item_ID(2) + item_protection_index(2)
      itemType = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
    } else if (infeVersion === 3) {
      itemId = ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
      p += 6; // item_ID(4) + item_protection_index(2)
      itemType = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
    }
    if (itemType === "Exif") return itemId;
    cursor += size;
  }
  return null;
}

// 解析 iloc box 内容，按 item_ID 查出对应数据在文件里的（偏移量, 长度）
function findIlocExtent(buf, start, end, itemId) {
  const version = buf[start];
  let cursor = start + 4; // 跳过 version(1)+flags(3)

  const sizesByte1 = buf[cursor++];
  const offsetSize = sizesByte1 >> 4;
  const lengthSize = sizesByte1 & 0x0f;
  const sizesByte2 = buf[cursor++];
  const baseOffsetSize = sizesByte2 >> 4;
  const indexSize = version === 1 || version === 2 ? sizesByte2 & 0x0f : 0;

  let itemCount;
  if (version < 2) {
    itemCount = (buf[cursor] << 8) | buf[cursor + 1];
    cursor += 2;
  } else {
    itemCount = ((buf[cursor] << 24) | (buf[cursor + 1] << 16) | (buf[cursor + 2] << 8) | buf[cursor + 3]) >>> 0;
    cursor += 4;
  }

  const readUint = (size) => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[cursor + i];
    cursor += size;
    return v;
  };

  for (let i = 0; i < itemCount && cursor < end; i++) {
    const curItemId = version < 2 ? readUint(2) : readUint(4);
    if (version === 1 || version === 2) cursor += 2; // construction_method
    cursor += 2; // data_reference_index
    const baseOffset = readUint(baseOffsetSize);
    const extentCount = (buf[cursor] << 8) | buf[cursor + 1];
    cursor += 2;

    let firstExtent = null;
    for (let e = 0; e < extentCount; e++) {
      if ((version === 1 || version === 2) && indexSize > 0) cursor += indexSize;
      const extentOffset = readUint(offsetSize);
      const extentLength = readUint(lengthSize);
      if (e === 0) firstExtent = { offset: baseOffset + extentOffset, length: extentLength };
    }
    if (curItemId === itemId) return firstExtent;
  }
  return null;
}

function parseExifTiff(buf, tiffStart) {
  const little = buf[tiffStart] === 0x49 && buf[tiffStart + 1] === 0x49; // "II"
  const u16 = (o) => (little ? buf[o] | (buf[o + 1] << 8) : (buf[o] << 8) | buf[o + 1]);
  const u32 = (o) =>
    little
      ? (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0
      : ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;

  function findTagValueOffset(ifdOffset, tagId) {
    const count = u16(ifdOffset);
    for (let i = 0; i < count; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (u16(entry) === tagId) return entry + 8;
    }
    return null;
  }

  function readAsciiAt(entryValueOffset) {
    const valueOffset = tiffStart + u32(entryValueOffset);
    const bytes = buf.slice(valueOffset, valueOffset + 19);
    return new TextDecoder().decode(bytes);
  }

  // GPSLatitude/GPSLongitude 各是 3 个 RATIONAL（度、分、秒），存在 value 字段指向的一段 24 字节里
  function readRationalTriplet(entryValueOffset) {
    const arrOffset = tiffStart + u32(entryValueOffset);
    let degrees = 0;
    for (let i = 0; i < 3; i++) {
      const num = u32(arrOffset + i * 8);
      const den = u32(arrOffset + i * 8 + 4);
      const val = den ? num / den : 0;
      degrees += i === 0 ? val : val / Math.pow(60, i);
    }
    return degrees;
  }

  function readGps(ifd0Offset) {
    const gpsPtrEntry = findTagValueOffset(ifd0Offset, 0x8825); // GPSInfoIFDPointer
    if (!gpsPtrEntry) return null;
    const gpsIfdOffset = tiffStart + u32(gpsPtrEntry);
    const latEntry = findTagValueOffset(gpsIfdOffset, 0x0002); // GPSLatitude
    const lonEntry = findTagValueOffset(gpsIfdOffset, 0x0004); // GPSLongitude
    const latRefEntry = findTagValueOffset(gpsIfdOffset, 0x0001); // GPSLatitudeRef ("N"/"S")
    const lonRefEntry = findTagValueOffset(gpsIfdOffset, 0x0003); // GPSLongitudeRef ("E"/"W")
    if (!latEntry || !lonEntry) return null;
    let lat = readRationalTriplet(latEntry);
    let lon = readRationalTriplet(lonEntry);
    // GPS*Ref 是 2 字节 ASCII（如 "N\0"），4 字节够装下，直接存在 value 字段里，不走 offset 间接寻址
    if (latRefEntry && buf[latRefEntry] === 0x53) lat = -lat; // "S"
    if (lonRefEntry && buf[lonRefEntry] === 0x57) lon = -lon; // "W"
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
    return { lat, lon };
  }

  try {
    const ifd0Offset = tiffStart + u32(tiffStart + 4);
    const exifIfdEntry = findTagValueOffset(ifd0Offset, 0x8769); // ExifIFDPointer
    let dateStr = null;
    if (exifIfdEntry) {
      const exifIfdOffset = tiffStart + u32(exifIfdEntry);
      const dtEntry = findTagValueOffset(exifIfdOffset, 0x9003); // DateTimeOriginal
      if (dtEntry) dateStr = readAsciiAt(dtEntry);
    }
    if (!dateStr) {
      const dtEntry = findTagValueOffset(ifd0Offset, 0x0132); // DateTime
      if (dtEntry) dateStr = readAsciiAt(dtEntry);
    }
    const gps = readGps(ifd0Offset);
    if (!dateStr) return gps ? { lat: gps.lat, lon: gps.lon } : null;
    const m = dateStr.match(/^(\d{4}):(\d{2}):(\d{2})/);
    if (!m) return gps ? { lat: gps.lat, lon: gps.lon } : null;
    return { year: m[1], month: m[2], day: m[3], lat: gps ? gps.lat : null, lon: gps ? gps.lon : null };
  } catch {
    return null;
  }
}

// 扩展 EXIF 解析：Make / Model / ExposureTime / FNumber / ISO / FocalLength / Lens / 分辨率
function parseExifForDisplay(buf) {
  // 找 JPEG EXIF 段（也支持直接 TIFF 文件头）
  let tiffStart = -1;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG
    let pos = 2;
    while (pos + 3 < buf.length) {
      if (buf[pos] !== 0xff) break;
      const marker = buf[pos + 1];
      const segLen = (buf[pos + 2] << 8) | buf[pos + 3];
      if (marker === 0xe1 && pos + 9 < buf.length &&
        buf[pos + 4] === 0x45 && buf[pos + 5] === 0x78 &&
        buf[pos + 6] === 0x69 && buf[pos + 7] === 0x66) {
        tiffStart = pos + 10; // skip APP1 marker(2) + length(2) + "Exif\0\0"(6)
        break;
      }
      if (marker === 0xda) break;
      pos += 2 + segLen;
    }
  } else if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) {
    tiffStart = 0; // raw TIFF / HEIF exif block
  }
  if (tiffStart < 0 || tiffStart + 8 > buf.length) return null;

  const little = buf[tiffStart] === 0x49;
  const u16 = (o) => little ? buf[o] | (buf[o+1]<<8) : (buf[o]<<8)|buf[o+1];
  const u32 = (o) => (little
    ? (buf[o]|(buf[o+1]<<8)|(buf[o+2]<<16)|(buf[o+3]<<24))
    : ((buf[o]<<24)|(buf[o+1]<<16)|(buf[o+2]<<8)|buf[o+3])) >>> 0;

  function ifdEntry(ifdOff, tag) {
    const cnt = u16(ifdOff);
    for (let i = 0; i < cnt; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 11 >= buf.length) break;
      if (u16(e) === tag) return e;
    }
    return -1;
  }

  function readAscii(e) {
    const len = u32(e + 4);
    const off = len <= 4 ? e + 8 : tiffStart + u32(e + 8);
    if (off >= buf.length) return '';
    let s = '';
    for (let i = 0; i < len && off + i < buf.length; i++) {
      const c = buf[off + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  }

  function readRational(e) {
    const off = tiffStart + u32(e + 8);
    if (off + 7 >= buf.length) return null;
    const n = u32(off), d = u32(off + 4);
    return d ? n / d : null;
  }

  function readSRational(e) {
    const off = tiffStart + u32(e + 8);
    if (off + 7 >= buf.length) return null;
    // signed 32-bit via two's complement
    const toS = v => (v >= 0x80000000 ? v - 0x100000000 : v);
    const n = toS(u32(off)), d = toS(u32(off + 4));
    return d ? n / d : null;
  }

  function readShort(e) {
    // SHORT (type=3): value fits in 4 bytes at offset+8
    return u16(e + 8);
  }

  try {
    const ifd0 = tiffStart + u32(tiffStart + 4);
    const result = {};

    const makeE = ifdEntry(ifd0, 0x010F);
    if (makeE >= 0) result.make = readAscii(makeE);

    const modelE = ifdEntry(ifd0, 0x0110);
    if (modelE >= 0) result.model = readAscii(modelE);

    const swE = ifdEntry(ifd0, 0x0131); // Software
    if (swE >= 0) result.software = readAscii(swE);

    // 图像尺寸（IFD0 中）
    const wE = ifdEntry(ifd0, 0xA002);
    const hE = ifdEntry(ifd0, 0xA003);
    // ExifIFD pointer
    const exifPtrE = ifdEntry(ifd0, 0x8769);
    if (exifPtrE >= 0) {
      const exifIfd = tiffStart + u32(exifPtrE + 8);

      const etE = ifdEntry(exifIfd, 0x829A); // ExposureTime
      if (etE >= 0) result.shutterSpeed = readRational(etE);

      const fnE = ifdEntry(exifIfd, 0x829D); // FNumber
      if (fnE >= 0) result.aperture = readRational(fnE);

      const isoE = ifdEntry(exifIfd, 0x8827); // ISOSpeedRatings
      if (isoE >= 0) result.iso = readShort(isoE);

      const flE = ifdEntry(exifIfd, 0x920A); // FocalLength
      if (flE >= 0) result.focalLength = readRational(flE);

      const fl35E = ifdEntry(exifIfd, 0xA405); // FocalLengthIn35mmFilm
      if (fl35E >= 0) result.focalLength35 = readShort(fl35E);

      const lensE = ifdEntry(exifIfd, 0xA434); // LensModel
      if (lensE >= 0) result.lens = readAscii(lensE);

      const pw = ifdEntry(exifIfd, 0xA002); // PixelXDimension
      const ph = ifdEntry(exifIfd, 0xA003); // PixelYDimension
      if (pw >= 0) result.width = u32(pw + 8);
      if (ph >= 0) result.height = u32(ph + 8);

      // Extended EXIF tags
      const dtE = ifdEntry(exifIfd, 0x9003); // DateTimeOriginal
      if (dtE >= 0) result.dateTime = readAscii(dtE);

      const csE = ifdEntry(exifIfd, 0xA001); // ColorSpace (1=sRGB)
      if (csE >= 0) result.colorSpace = readShort(csE) === 1 ? 'sRGB' : 'uncalibrated';

      const wbE = ifdEntry(exifIfd, 0xA403); // WhiteBalance (0=auto, 1=manual)
      if (wbE >= 0) result.whiteBalance = readShort(wbE);

      const epE = ifdEntry(exifIfd, 0x8822); // ExposureProgram
      if (epE >= 0) result.exposureProgram = readShort(epE);

      const mmE = ifdEntry(exifIfd, 0x9207); // MeteringMode
      if (mmE >= 0) result.meteringMode = readShort(mmE);

      const flashE = ifdEntry(exifIfd, 0x9209); // Flash
      if (flashE >= 0) result.flash = readShort(flashE);

      const maxAptE = ifdEntry(exifIfd, 0x9205); // MaxApertureValue (APEX rational)
      if (maxAptE >= 0) {
        const apex = readRational(maxAptE);
        if (apex !== null) result.maxAperture = +(Math.pow(2, apex / 2).toFixed(2));
      }

      const sctE = ifdEntry(exifIfd, 0xA406); // SceneCaptureType
      if (sctE >= 0) result.sceneCaptureType = readShort(sctE);

      const otE = ifdEntry(exifIfd, 0x9011); // OffsetTimeOriginal (timezone, e.g. "+08:00")
      if (otE >= 0) result.offsetTime = readAscii(otE);

      const emE = ifdEntry(exifIfd, 0xA402); // ExposureMode (0=auto, 1=manual, 2=auto-bracket)
      if (emE >= 0) result.exposureMode = readShort(emE);

      const bvE = ifdEntry(exifIfd, 0x9203); // BrightnessValue (SRATIONAL, EV)
      if (bvE >= 0) result.brightnessValue = readSRational(bvE);

      const smE = ifdEntry(exifIfd, 0xA217); // SensingMethod
      if (smE >= 0) result.sensingMethod = readShort(smE);
    }
    // Fallback dims from IFD0
    if (!result.width && wE >= 0) result.width = u32(wE + 8);
    if (!result.height && hE >= 0) result.height = u32(hE + 8);

    // GPS IFD
    const gpsPtrE = ifdEntry(ifd0, 0x8825);
    if (gpsPtrE >= 0) {
      const gpsOff = tiffStart + u32(gpsPtrE + 8);
      if (gpsOff + 2 < buf.length) {
        function readRationalArr(e, count) {
          const off = tiffStart + u32(e + 8);
          const out = [];
          for (let k = 0; k < count; k++) {
            const base = off + k * 8;
            if (base + 7 >= buf.length) break;
            const n = u32(base), d = u32(base + 4);
            out.push(d ? n / d : 0);
          }
          return out;
        }
        const latRefE = ifdEntry(gpsOff, 0x0001);
        const latGE  = ifdEntry(gpsOff, 0x0002);
        const lngRefE = ifdEntry(gpsOff, 0x0003);
        const lngGE  = ifdEntry(gpsOff, 0x0004);
        if (latGE >= 0 && lngGE >= 0) {
          const la = readRationalArr(latGE, 3);
          const ln = readRationalArr(lngGE, 3);
          if (la.length === 3 && ln.length === 3) {
            const latDeg = la[0] + la[1] / 60 + la[2] / 3600;
            const lngDeg = ln[0] + ln[1] / 60 + ln[2] / 3600;
            const latRef = latRefE >= 0 ? readAscii(latRefE) : 'N';
            const lngRef = lngRefE >= 0 ? readAscii(lngRefE) : 'E';
            result.lat = latRef.startsWith('S') ? -latDeg : latDeg;
            result.lng = lngRef.startsWith('W') ? -lngDeg : lngDeg;
            function toDMS(v, posC, negC) {
              const a = Math.abs(v), d = Math.floor(a);
              const mt = (a - d) * 60, m = Math.floor(mt);
              const s = ((mt - m) * 60).toFixed(2);
              return `${d}°${m}'${s}"${v >= 0 ? posC : negC}`;
            }
            result.latDMS = toDMS(result.lat, 'N', 'S');
            result.lngDMS = toDMS(result.lng, 'E', 'W');
          }
        }
        const altRefE = ifdEntry(gpsOff, 0x0005);
        const altGE  = ifdEntry(gpsOff, 0x0006);
        if (altGE >= 0) {
          const alt = readRational(altGE);
          const sign = (altRefE >= 0 && buf[altRefE + 8] === 1) ? -1 : 1;
          if (alt !== null) result.altitude = Math.round(alt * sign);
        }
      }
    }

    return Object.keys(result).length ? result : null;
  } catch {
    return null;
  }
}

async function readHeicExifForDisplay(bucket, key) {
  const headObj = await bucket.get(key, { range: { offset: 0, length: 262144 } });
  if (!headObj) return null;
  const buf = new Uint8Array(await headObj.arrayBuffer());

  const metaBox = findIsoBox(buf, 0, buf.length, "meta");
  if (!metaBox) return null;
  const metaContentStart = metaBox.contentStart + 4;

  const iinfBox = findIsoBox(buf, metaContentStart, metaBox.contentEnd, "iinf");
  const ilocBox = findIsoBox(buf, metaContentStart, metaBox.contentEnd, "iloc");
  if (!iinfBox || !ilocBox) return null;

  const exifItemId = findExifItemId(buf, iinfBox.contentStart, iinfBox.contentEnd);
  if (exifItemId == null) return null;

  const extent = findIlocExtent(buf, ilocBox.contentStart, ilocBox.contentEnd, exifItemId);
  if (!extent || extent.length < 8) return null;

  const exifObj = await bucket.get(key, { range: { offset: extent.offset, length: extent.length } });
  if (!exifObj) return null;
  const exifBuf = new Uint8Array(await exifObj.arrayBuffer());

  // HEIC 的 Exif item 前 4 字节是 TIFF 头偏移；把 TIFF 切出来后复用展示页的 EXIF 解析器。
  const tiffHeaderOffset = (exifBuf[0] << 24) | (exifBuf[1] << 16) | (exifBuf[2] << 8) | exifBuf[3];
  const tiffStart = 4 + tiffHeaderOffset;
  if (tiffStart < 0 || tiffStart + 8 > exifBuf.length) return null;
  return parseExifForDisplay(exifBuf.slice(tiffStart));
}

async function handleExif(request, env, url) {
  const key = url.searchParams.get("key");
  if (!key || key.length > 500) return new Response("Bad Request", { status: 400 });

  // EXIF 是照片自带的不变元数据，解析一次全网复用——尤其 HEIC 要走一整套
  // ISOBMFF box 查找 + TIFF 解析，之前只有浏览器缓存头，每个访问者都重复解析一遍
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cachedResp = await cache.match(cacheKey);
  if (cachedResp) return cachedResp;

  let obj = null;
  let exif = {};
  if (/\.heic$/i.test(key)) {
    // HEIC 的 EXIF 不在普通图片头里，先按 ISOBMFF meta/iinf/iloc 找到 Exif item 再解析。
    exif = (await readHeicExifForDisplay(env.PHOTOS, key)) || {};
    obj = await env.PHOTOS.head(key);
  } else {
    // JPEG 的 EXIF 通常在文件头部，读一小段即可。
    obj = await env.PHOTOS.get(key, { range: { offset: 0, length: 65536 } });
    if (!obj) return new Response("Not Found", { status: 404 });
    const buf = new Uint8Array(await obj.arrayBuffer());
    exif = parseExifForDisplay(buf) || {};
  }
  if (!obj) return new Response("Not Found", { status: 404 });
  if (obj.size) exif.fileSize = obj.size;
  const response = new Response(JSON.stringify(exif), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      "access-control-allow-origin": "*",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

async function handleStaticMap(request, env, url) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return new Response("Bad Request", { status: 400 });
  }
  const token = env.MAPBOX_PUBLIC_TOKEN;
  if (!token) return new Response("Not configured", { status: 503 });
  const mapUrl =
    `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/` +
    `pin-s+e84a3a(${lng.toFixed(6)},${lat.toFixed(6)})/` +
    `${lng.toFixed(6)},${lat.toFixed(6)},13,0/` +
    `320x160@2x?access_token=${token}`;
  const resp = await fetch(mapUrl);
  if (!resp.ok) return new Response("Map unavailable", { status: 502 });
  return new Response(resp.body, {
    headers: {
      "content-type": resp.headers.get("content-type") || "image/png",
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}

const MIME_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mov: "video/quicktime",
  mp4: "video/mp4",
};

// ---------- 图片代理 ----------
async function handleImage(request, env, url) {
  const key = decodeURIComponent(url.pathname.replace(/^\/img\//, ""));
  if (!key) return new Response("Bad Request", { status: 400 });

  // 视频播放（哪怕只是 preload="metadata" 取个封面帧）天生靠 Range 请求局部读取文件，
  // 没有 Range 支持的话浏览器要么读不到视频信息、要么被迫等整个文件下载完，大文件会一直转圈卡住
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    return handleImageRange(env, key, rangeHeader, url);
  }

  // 照片内容不会变（key 不变就是同一份文件），显式用边缘缓存挡住重复的 R2 get，
  // 同一张照片被很多人/很多节点反复请求时，B 类操作能省下不少
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cachedResp = await cache.match(cacheKey);
  if (cachedResp) return cachedResp;

  const object = await env.PHOTOS.get(key);
  if (!object) return new Response("Not Found", { status: 404 });

  const ext = key.split(".").pop().toLowerCase();
  const headers = new Headers();
  headers.set("content-type", MIME_TYPES[ext] || "application/octet-stream");
  headers.set("accept-ranges", "bytes"); // 告诉浏览器这个资源支持区间请求，视频才会用 Range 来读
  if (url.searchParams.get("dl") === "1") {
    // 下载模式：附带文件名触发浏览器另存为
    const filename = key.split("/").pop();
    headers.set("content-disposition", `attachment; filename="${filename}"`);
  } else {
    // 强制 inline，避免浏览器把 R2 上传时附带的 content-disposition: attachment 带过来触发下载
    headers.set("content-disposition", "inline");
  }
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");

  const response = new Response(object.body, { headers });
  // 边缘缓存只是优化，存不进去（比如大视频文件在某些边缘节点上触发了 Cache API 的内部限制）
  // 不该连累这次响应本身直接 500——之前这里没接住过，视频缩略图悬浮自动播放偶发出现过这个问题
  try {
    await cache.put(cacheKey, response.clone());
  } catch (err) {
    console.error("cache.put failed for", key, err);
  }
  return response;
}

// 处理带 Range 头的请求（主要是视频拖动/取封面帧），返回 206 Partial Content。
// 206 响应本身不进边缘缓存——Cache API 不支持缓存 Partial Content，cache.put 对 206 必定抛错，
// 之前就是因为没接住这个错误才会一加了视频悬浮自动播放就到处 500
async function handleImageRange(env, key, rangeHeader, url) {
  const cache = caches.default;
  // 文件总大小缓存一下，避免视频拖动时每个 Range 请求都先单独发一次 head() 调用
  const sizeCacheKey = new Request("https://memories.internal/size-cache/" + encodeURIComponent(key));
  let totalSize;
  const cachedSize = await cache.match(sizeCacheKey);
  if (cachedSize) {
    totalSize = Number(await cachedSize.text());
  } else {
    const head = await env.PHOTOS.head(key);
    if (!head) return new Response("Not Found", { status: 404 });
    totalSize = head.size;
    await cache.put(
      sizeCacheKey,
      new Response(String(totalSize), { headers: { "cache-control": "max-age=31536000, immutable" } })
    );
  }

  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return new Response("Invalid Range", { status: 416 });

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
  if (start >= totalSize || end >= totalSize || start > end) {
    return new Response("Range Not Satisfiable", { status: 416, headers: { "content-range": `bytes */${totalSize}` } });
  }

  const object = await env.PHOTOS.get(key, { range: { offset: start, length: end - start + 1 } });
  if (!object) return new Response("Not Found", { status: 404 });

  const ext = key.split(".").pop().toLowerCase();
  const headers = new Headers();
  headers.set("content-type", MIME_TYPES[ext] || "application/octet-stream");
  headers.set("accept-ranges", "bytes");
  headers.set("content-range", `bytes ${start}-${end}/${totalSize}`);
  headers.set("content-length", String(end - start + 1));
  headers.set("cache-control", "public, max-age=31536000, immutable");

  return new Response(object.body, { status: 206, headers });
}

// ---------- 缩略图：用 Cloudflare Images 的 Workers Binding 做缩放，账号级别功能，Free 套餐也能用
// （跟 zone 级别的 /cdn-cgi/image/ Image Resizing 是两个不同的东西，那个需要 Pro 起步，Free 套餐会直接 415）----------
// HEIC 文件的 JPEG 预转码版本存进 PREVIEWS 桶，按拍摄日期分 年/月/日 文件夹（而不是照搬原图的 年/月 路径）——
// 原图文件名里大多没有日期、文件名也可能重复，按拍摄日期分文件夹能把同一天的预览图聚在一起，方便后续按日期批量清理
function yearFromKey(key) {
  const m = key.match(new RegExp(`^${BASE_PREFIX.replace(/\//g, "\\/")}(\\d{4})\\/`));
  return m ? m[1] : "unknown";
}

async function heicPreviewKeyFor(env, key) {
  const basename = key.split("/").pop().replace(/\.heic$/i, "") + ".heic-preview.jpg";
  const year = yearFromKey(key);
  // getCapturedMonthDay 本身有缓存（见上面），同一张照片重复调用不会重新读 EXIF
  const md = await getCapturedMonthDay(env.PHOTOS, key);
  const month = md ? md.month : "00";
  const day = md ? md.day : "00";
  return `${year}/${month}/${day}/${basename}`;
}

// 改用 年/月/日 路径之前生成的预览版用的是这套旧规则（照搬原图的 年/月 路径），
// 旧文件还没迁移完之前两套路径都要认，不然已经转好的预览版会被当成"没转"，又走一次现场解码兜底，体感变慢
function heicPreviewKeyLegacy(key) {
  return key.replace(/\.heic$/i, "") + ".heic-preview.jpg";
}

// 转码失败时写的占位图（最小合法 JPEG，没有真实图像数据），用来标记"试过了"，
// 避免每次批量任务都对一张解不开的图重新跑一次解码；占位图体积固定 4 字节，靠这个跟真预览图区分
const HEIC_PREVIEW_PLACEHOLDER = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xD9]);
const HEIC_RETRY_LIMIT = 5; // 失败这么多次之后就放弃自动重试，别死磕一张真解不开的坏文件

function isHeicPlaceholder(head) {
  return head.size <= HEIC_PREVIEW_PLACEHOLDER.length;
}

// 优先找新路径，找不到再退回旧路径，都没有就返回 null（连同对应的 head() 结果一起返回，
// 方便调用方判断这是真预览图还是失败占位图）
async function findHeicPreviewHead(env, key) {
  const newKey = await heicPreviewKeyFor(env, key);
  const newHead = await env.PREVIEWS.head(newKey);
  if (newHead) return { key: newKey, head: newHead };
  const legacyKey = heicPreviewKeyLegacy(key);
  const legacyHead = await env.PREVIEWS.head(legacyKey);
  if (legacyHead) return { key: legacyKey, head: legacyHead };
  return null;
}

async function findHeicPreviewKey(env, key) {
  const found = await findHeicPreviewHead(env, key);
  return found ? found.key : null;
}

// 是否还需要（重新）生成预览图：没转过，或者转过但是失败占位图、且重试次数没到上限。
// 用于服务端批量转码（Cron/管理端点）——服务端解码次数有限，超过上限就不再自动重试，省 CPU
async function needsHeicConversion(env, key) {
  const found = await findHeicPreviewHead(env, key);
  if (!found) return true;
  if (!isHeicPlaceholder(found.head)) return false; // 已经有真预览图
  const attempts = Number(found.head.customMetadata && found.head.customMetadata.attempts) || 0;
  return attempts < HEIC_RETRY_LIMIT;
}

// 是否已经有一份真预览图（不管重试次数）。浏览器端 heic2any 解码不占用服务端的重试名额——
// 哪怕服务端那 5 次都失败放弃了，用户自己在浏览器里解码成功了，回传上来照样应该被接受存进去
async function hasRealHeicPreview(env, key) {
  const found = await findHeicPreviewHead(env, key);
  return !!found && !isHeicPlaceholder(found.head);
}

// 浏览器端 heic2any 现场解码兜底之后，顺手把结果回传存进 PREVIEWS 桶——下次同一张照片
// 不用再让另一个访问者重新解码一遍。整站本来就挡在 Cloudflare Access 后面，这里只做基本校验，
// 不需要再加一层 ADMIN_TOKEN
async function handleUploadHeicPreview(request, env, url) {
  const key = url.searchParams.get("key");
  if (!key || !/\.heic$/i.test(key) || !key.startsWith(BASE_PREFIX)) {
    return new Response("Bad Request", { status: 400 });
  }

  const buffer = new Uint8Array(await request.arrayBuffer());
  // 快速预检：JPEG 魔数（FF D8 开头），不是的直接拒绝，省掉后面的解码开销
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return new Response("Bad Request: not a JPEG", { status: 400 });
  }
  // 限制一下大小，浏览器端解码出来的预览图正常不会很大，避免有人故意传超大文件占地方
  if (buffer.length > 10 * 1024 * 1024) {
    return new Response("Payload Too Large", { status: 413 });
  }
  // 真解码验证：魔数很容易伪造（前两个字节对了就行），用 IMAGES binding 实际解一遍，
  // 确认整个文件是合法 JPEG 且尺寸在合理范围——站点是公开的，这个端点等于对外可写 R2，
  // 校验必须做在服务端
  try {
    const info = await env.IMAGES.info(new Blob([buffer]).stream());
    if (info.format !== "image/jpeg" || !info.width || !info.height ||
        info.width > 12000 || info.height > 12000) {
      return new Response("Bad Request: invalid image", { status: 400 });
    }
  } catch {
    return new Response("Bad Request: undecodable image", { status: 400 });
  }

  // 已经有真预览版（不管是服务端转的还是别人先传过的）就不用再写一次；如果只是个失败占位图
  // （不管服务端重试次数有没有用完），浏览器这边解出来了正好顶上——用 hasRealHeicPreview 而不是
  // needsHeicConversion，不然服务端 5 次重试用完之后浏览器端的解码结果也会被这里拒绝接收
  if (await hasRealHeicPreview(env, key)) {
    return new Response(JSON.stringify({ uploaded: false, reason: "already exists" }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const head = await env.PHOTOS.head(key);
  if (!head) return new Response("Not Found", { status: 404 });

  const previewKey = await heicPreviewKeyFor(env, key);
  await env.PREVIEWS.put(previewKey, buffer, { httpMetadata: { contentType: "image/jpeg" } });

  return new Response(JSON.stringify({ uploaded: true }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// 给一张 HEIC 照片生成预览版，存进单独的 PREVIEWS 桶（跟原图分开，方便单独清理/计费）。
// 跳过已经有真预览版的；之前失败过的占位图会在重试次数没到上限前继续重试。返回是否真的转了
async function generateHeicPreview(env, key) {
  const previewKey = await heicPreviewKeyFor(env, key);
  if (!(await needsHeicConversion(env, key))) return false;

  const object = await env.PHOTOS.get(key);
  if (!object) return false;

  try {
    const transformed = await env.IMAGES.input(object.body)
      .transform({})
      .output({ format: "image/jpeg", quality: 85 });
    const jpegBytes = await transformed.response().arrayBuffer();
    await env.PREVIEWS.put(previewKey, jpegBytes, { httpMetadata: { contentType: "image/jpeg" } });
    return true;
  } catch (err) {
    // 转码失败（文件损坏、不支持的 HEIC 变体等），写一个最小占位 JPEG 标记"试过了"，
    // 记一下这是第几次失败——重试次数没到上限前，下次批量任务还会再来一次
    const prevHead = await env.PREVIEWS.head(previewKey);
    const prevAttempts = Number(prevHead && prevHead.customMetadata && prevHead.customMetadata.attempts) || 0;
    await env.PREVIEWS.put(previewKey, HEIC_PREVIEW_PLACEHOLDER, {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { attempts: String(prevAttempts + 1) },
    });
    throw err; // 仍然抛出，让上层记录错误信息
  }
}


async function handleThumb(request, env, url) {
  const origKey = decodeURIComponent(url.pathname.replace(/^\/thumb\//, ""));
  if (!origKey) return new Response("Bad Request", { status: 400 });

  const width  = Math.min(Math.max(Number(url.searchParams.get("w")) || 400, 1), 2000);
  const height = url.searchParams.get("h") ? Math.min(Math.max(Number(url.searchParams.get("h")), 1), 2000) : undefined;
  const fit    = url.searchParams.get("fit") || "scale-down";

  // 存进 PREVIEWS 的 WebP 缩略图路径：thumbs/{尺寸}/{原始路径去扩展名}.webp
  const dimStr   = height ? `${width}x${height}` : `${width}`;
  const thumbKey = `thumbs/${dimStr}/${origKey.replace(/\.[^.]+$/, "")}.webp`;
  const publicUrl = `${env.PREVIEWS_PUBLIC_URL}/${thumbKey}`;

  // 先查边缘缓存（302 本身也可以缓存，省掉每次的 PREVIEWS.head 调用）
  const cacheKey = new Request(`https://thumb-redirect/${thumbKey}`);
  const cachedRedirect = await caches.default.match(cacheKey);
  if (cachedRedirect) return cachedRedirect;

  // 缩略图已存在 → 直接 302，Worker 不再传图片体
  const existing = await env.PREVIEWS.head(thumbKey);
  if (existing) {
    const resp = thumbRedirect(publicUrl);
    await caches.default.put(cacheKey, resp.clone());
    return resp;
  }

  // IMAGES binding 原生支持 HEIC，直接从原图桶读，无需 JPEG 中间转换
  const object = await env.PHOTOS.get(origKey);
  if (!object) return new Response("Not Found", { status: 404 });

  try {
    const transformed = await env.IMAGES.input(object.body)
      .transform({ width, ...(height ? { height } : {}), fit })
      .output({ format: "image/webp", quality: 75 });
    const buf = await transformed.response().arrayBuffer();

    // 存入 PREVIEWS，后续请求直接走 R2 公开 CDN，不再经过 Worker 的 IMAGES 变换
    await env.PREVIEWS.put(thumbKey, buf, {
      httpMetadata: { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" },
    });

    const resp = thumbRedirect(publicUrl);
    await caches.default.put(cacheKey, resp.clone());
    return resp;
  } catch (err) {
    // 一定要把原因打出来——这里静默过一次，Transformations 免费额度（每月 5000 次独立变换）
    // 用完后 HEIC 缩略图全裂，却查不到任何线索
    console.error("thumb transform failed for", origKey, err);

    // HEIC 原图浏览器显示不了，退回 /img/ 等于必裂。优先找 convertHeicBatch 预转的
    // JPEG 预览顶上（302 不写进正式缩略图的缓存位，额度恢复后下次请求还会重新走 transform）
    if (/\.heic$/i.test(origKey)) {
      const previewKey = await findHeicPreviewKey(env, origKey);
      if (previewKey) {
        return thumbRedirect(`${env.PREVIEWS_PUBLIC_URL}/${previewKey.split("/").map(encodeURIComponent).join("/")}`, "public, max-age=3600");
      }
    }
    return handleImage(request, env, new URL(url.toString().replace("/thumb/", "/img/")));
  }
}

// 正式缩略图的 key 含尺寸、内容不可变，302 直接给一年 immutable，省掉每天每节点一次回源；
// HEIC 预览兜底那条传短时限——那是变换额度用尽时的临时指路，额度恢复后要能换回正式缩略图
function thumbRedirect(publicUrl, cacheControl = "public, max-age=31536000, immutable") {
  return new Response(null, {
    status: 302,
    headers: {
      "location": publicUrl,
      "cache-control": cacheControl,
    },
  });
}

// ---------- AI 选片：用 Workers AI 给照片打"值不值得展示"的分，离线批处理，结果存进 D1 ----------
// （原来这里有个全表版 loadScores()——连 raw_response 大文本一起整张读进内存，
//   照片多了以后是 Cron 的头号内存包袱。所有调用方都改成 loadScoresForKeys /
//   findUnscoredKeys 的 SQL 侧筛选后已删除，别再加回来）

// D1 单条语句的绑定参数上限是 100 个——年头跨度大、某天又凑巧拍得多时，一天命中的 key 数量
// 完全可能超过 100，IN (?,?,...) 一超就直接报错（之前是这里把整个 /api/memories 拖成 500）。
// 按 100 个一批拆开查，并行发出去再合并结果
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// 只查指定 key 列表（用于 /api/memories：一天命中的照片就几十张，不用每次把整张表读出来）
async function loadScoresForKeys(env, keys) {
  if (keys.length === 0) return {};
  const batches = await Promise.all(
    chunkArray(keys, 100).map((batch) => {
      const placeholders = batch.map(() => "?").join(",");
      // 不查 raw_response——那是 AI 原始响应全文（每行几百字节到几 KB），只在 saveScore 时
      // 写入留档，这里的调用方（/api/memories、打分候选筛选）都只用 score/has_face/caption
      return env.DB.prepare(
        `SELECT key, score, has_face, caption, updated_at FROM photo_scores WHERE key IN (${placeholders})`
      )
        .bind(...batch)
        .all();
    })
  );
  const scores = {};
  for (const { results } of batches) {
    for (const row of results) {
      scores[row.key] = {
        score: row.score,
        hasFace: !!row.has_face,
        caption: row.caption || "",
        updatedAt: row.updated_at || "",
      };
    }
  }
  return scores;
}

async function saveScore(env, key, info) {
  await env.DB.prepare(
    "INSERT INTO photo_scores (key, score, has_face, caption, raw_response, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET score = excluded.score, has_face = excluded.has_face, " +
      "caption = excluded.caption, raw_response = excluded.raw_response, updated_at = excluded.updated_at"
  )
    .bind(key, info.score, info.hasFace ? 1 : 0, info.caption || "", info.rawResponse || "", new Date().toISOString())
    .run();
}

// 真正调用 AI 给一张照片打分+生成文案，失败就给个中庸兜底，不让它一直卡在"未打分"里反复重试。
// 文案跟打分用同一次 AI 调用一起出，省一次子请求/模型调用。原始返回文本也存下来——
// 以后改 prompt/换模型时方便对比效果，解析失败时也方便排查到底是哪一步错了
// AI 打分用的视觉模型吃不下 HEIC 原始字节（"Unsupported image data"，每张 HEIC 都会失败，
// 之前一直在默默吃掉这个错误，回退成 score=5/caption=""）——HEIC 要先转成 JPEG 才能喂给模型。
// 优先用已经生成好的预览图（PREVIEWS 桶），没有的话现场解码一次，免得重复跑两套转码逻辑
async function getJpegBytesForScoring(env, key) {
  if (!/\.heic$/i.test(key)) {
    const obj = await env.PHOTOS.get(key);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }
  const previewKey = await findHeicPreviewKey(env, key);
  if (previewKey) {
    const previewObj = await env.PREVIEWS.get(previewKey);
    if (previewObj) {
      const bytes = new Uint8Array(await previewObj.arrayBuffer());
      if (bytes.length > HEIC_PREVIEW_PLACEHOLDER.length) return bytes; // 不是失败占位图才能用
    }
  }
  const obj = await env.PHOTOS.get(key);
  if (!obj) return null;
  const transformed = await env.IMAGES.input(obj.body)
    .transform({ width: 1024 })
    .output({ format: "image/jpeg", quality: 85 });
  return new Uint8Array(await transformed.response().arrayBuffer());
}

async function scoreOnePhoto(env, key) {
  try {
    const buffer = await getJpegBytesForScoring(env, key);
    if (!buffer) return null;
    const aiResult = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
      image: Array.from(buffer),
      prompt:
        "Look at this personal photo. Reply with exactly three lines, nothing else:\n" +
        "SCORE: <a number 1-10 for how memorable/worth keeping it is " +
        "(real candid moments, scenery, clear faces > blurry/accidental/duplicate-looking shots > screenshots, memes, scanned text/documents)>\n" +
        "FACE: <yes if there is at least one recognizable human face in the photo, otherwise no>\n" +
        "CAPTION: <one short, warm, casual sentence in Chinese describing what's happening in this photo, like a caption you'd write in a photo album>",
      max_tokens: 80,
    });
    const text = (aiResult && (aiResult.description || aiResult.response)) || "";
    const scoreMatch = text.match(/SCORE:\s*(\d+)/i);
    const score = scoreMatch ? Math.max(1, Math.min(10, parseInt(scoreMatch[1], 10))) : 5;
    const hasFace = /FACE:\s*yes/i.test(text);
    const captionMatch = text.match(/CAPTION:\s*(.+)/i);
    let caption = captionMatch ? captionMatch[1].trim() : "";
    // llava-1.5 经常不老实听话，prompt 里写了 in Chinese 还是会用英文回——
    // 检测一下文案里有没有中文字符，没有就过一遍专门的翻译模型转成中文，翻译失败就留着英文兜底
    if (caption && !/[一-鿿]/.test(caption)) {
      try {
        const translated = await env.AI.run("@cf/meta/m2m100-1.2b", {
          text: caption,
          source_lang: "english",
          target_lang: "chinese",
        });
        caption = (translated && (translated.translated_text || translated.response)) || caption;
      } catch {
        // 翻译失败就保留英文原文，好歹有文案
      }
    }
    return { score, hasFace, caption, rawResponse: text };
  } catch (err) {
    return { score: 5, hasFace: false, caption: "", rawResponse: String(err && err.message ? err.message : err) };
  }
}

// key 还没打过分时 loadScores() 返回的对象里没有这一项，统一给个默认值方便调用方直接解构
function scoreInfoOf(entry) {
  return entry || { score: null, hasFace: false, caption: "", updatedAt: "" };
}

// 之前打过分但还没补上 AI 文案的（caption 字段加得比打分晚），或者文案是翻译功能上线前
// 生成的英文老文案，都要算作"需要处理"，不然这批照片永远不会再被 scoreOnePhoto 碰到
function needsScoring(scores, key) {
  if (!(key in scores)) return true;
  const caption = scores[key].caption;
  return !caption || !/[一-鿿]/.test(caption);
}

// needsScoring 的 SQL 版：直接在库里 LEFT JOIN 筛出需要打分的 key，调用方不用再把整张
// photo_scores（含 raw_response 大文本列）读进内存逐个过滤——那是 Cron 里最大的内存包袱。
// "文案没有中文"用 字节数==字符数（纯 ASCII）近似：有中文时 UTF-8 字节数必然大于字符数。
// 跟正则 /[一-鿿]/ 的口径差在纯 emoji/带音标文案会被当成"有内容"，但文案是提示词约定的中文，
// 实际打出来不会是那两种
const NEEDS_SCORE_SQL =
  "(s.key IS NULL OR s.caption IS NULL OR s.caption = '' OR length(CAST(s.caption AS BLOB)) = length(s.caption))";

async function findUnscoredKeys(env, { month, day, limit }) {
  const conds = ["i.type = 'image'", NEEDS_SCORE_SQL];
  const binds = [];
  if (month && day) { conds.push("i.month = ?", "i.day = ?"); binds.push(month, day); }
  const { results } = await env.DB.prepare(
    `SELECT i.key FROM photos_index i LEFT JOIN photo_scores s ON s.key = i.key WHERE ${conds.join(" AND ")} LIMIT ?`
  ).bind(...binds, limit).all();
  return results.map((r) => r.key);
}

// 同上：还没查过地点的 key（enrichLocations 对没 GPS 的也会记一行空结果，
// 所以 photo_places 里没有行 == 真没处理过）
async function findUnlocatedKeys(env, { month, day, limit }) {
  const conds = ["i.type = 'image'", "p.key IS NULL"];
  const binds = [];
  if (month && day) { conds.push("i.month = ?", "i.day = ?"); binds.push(month, day); }
  const { results } = await env.DB.prepare(
    `SELECT i.key FROM photos_index i LEFT JOIN photo_places p ON p.key = i.key WHERE ${conds.join(" AND ")} LIMIT ?`
  ).bind(...binds, limit).all();
  return results.map((r) => r.key);
}

// 按"优先日期在前，其余照片补足"凑一批候选 key。findFn 是上面两个 SQL 筛选函数之一
async function collectCandidates(env, findFn, priorityDays, poolSize) {
  const out = [];
  const seen = new Set();
  for (const { month, day } of priorityDays) {
    if (out.length >= poolSize) break;
    for (const key of await findFn(env, { month, day, limit: poolSize - out.length })) {
      if (!seen.has(key)) { seen.add(key); out.push(key); }
    }
  }
  if (out.length < poolSize) {
    // 全库查询会把优先日期的 key 再查出来一遍，多要一些配额再靠 seen 去重
    for (const key of await findFn(env, { limit: poolSize + out.length })) {
      if (out.length >= poolSize) break;
      if (!seen.has(key)) { seen.add(key); out.push(key); }
    }
  }
  return out;
}

// 给一批 key 打分并存进 D1（内部会跳过已经打过分+有文案的 key），返回这次实际处理了几张
async function scoreKeys(env, keys) {
  const scores = await loadScoresForKeys(env, keys);
  const toScore = keys.filter((key) => needsScoring(scores, key));
  for (const key of toScore) {
    const info = await scoreOnePhoto(env, key);
    if (info) await saveScore(env, key, info);
  }
  return toScore.length;
}

// ---------- 拍摄地点：从 EXIF GPS 反向地理编码成地名，离线批处理，结果存进 D1 ----------
// （全表版 loadPlaces() 同 loadScores() 一起删了——调用方都改走 loadPlacesForKeys /
//   findUnlocatedKeys 的 SQL 侧筛选）

// 同 loadScoresForKeys：只查指定 key 列表
async function loadPlacesForKeys(env, keys) {
  if (keys.length === 0) return {};
  const batches = await Promise.all(
    chunkArray(keys, 100).map((batch) => {
      const placeholders = batch.map(() => "?").join(",");
      return env.DB.prepare(
        `SELECT key, lat, lon, name FROM photo_places WHERE key IN (${placeholders})`
      )
        .bind(...batch)
        .all();
    })
  );
  const places = {};
  for (const { results } of batches) {
    for (const row of results) {
      places[row.key] = { lat: row.lat, lon: row.lon, name: row.name || "" };
    }
  }
  return places;
}

async function savePlace(env, key, entry) {
  await env.DB.prepare(
    "INSERT INTO photo_places (key, lat, lon, name) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, name = excluded.name"
  )
    .bind(key, entry.lat, entry.lon, entry.name || "")
    .run();
}

// key 没查过地点时 loadPlaces() 返回的对象里没有这一项，缺失就是 null
function placeNameOf(entry) {
  return (entry && entry.name) || null;
}

// 只取文件头部读 EXIF 里的 GPS 坐标，复用现成的 JPEG/HEIC 解析（同一份函数，只是这里只要 lat/lon）
async function getExifGps(bucket, key) {
  let info = null;
  if (/\.jpe?g$/i.test(key)) {
    info = await readJpegExifDate(bucket, key);
  } else if (/\.heic$/i.test(key)) {
    try {
      info = await readHeicExifDate(bucket, key);
    } catch {
      info = null;
    }
  }
  return info && typeof info.lat === "number" && typeof info.lon === "number" ? { lat: info.lat, lon: info.lon } : null;
}

// 用 Mapbox 的 Geocoding API 把经纬度转成地名。这里用的是 secret token，只在服务端调用，
// 绝不能把它放进前端代码（前端地图页用的是另一个 public token）
async function reverseGeocode(env, lat, lon) {
  try {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json` +
      `?types=place&language=zh-Hans&access_token=${env.MAPBOX_TOKEN}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error("reverseGeocode failed", resp.status, await resp.text(), "lat/lon:", lat, lon, "token set:", !!env.MAPBOX_TOKEN);
      return "";
    }
    const data = await resp.json();
    const feature = data.features && data.features[0];
    return (feature && feature.text) || "";
  } catch (err) {
    console.error("reverseGeocode threw", err);
    return "";
  }
}

// 给一批 key 查地点并存回 R2（内部会跳过已经查过的 key，不管查到没查到都算"查过"）
// 返回这次实际处理了几张。视频跳过，没有 GPS 信息的也会记一个空结果，避免下次又重新查一遍
// 存的是 {lat, lon, name}（不只是地名文字），这样地图页才能直接拿来打点，不用再重新读一遍 EXIF
async function enrichLocations(env, keys) {
  const places = await loadPlacesForKeys(env, keys);
  const toProcess = keys.filter((key) => !(key in places) && IMAGE_EXT.test(key));
  for (const key of toProcess) {
    const gps = await getExifGps(env.PHOTOS, key);
    if (gps) {
      const name = await reverseGeocode(env, gps.lat, gps.lon);
      await savePlace(env, key, { lat: gps.lat, lon: gps.lon, name });
    } else {
      await savePlace(env, key, { lat: null, lon: null, name: "" });
    }
  }
  return toProcess.length;
}

// 管理端点：每次调用只处理一小批未打分的照片（避免单次请求超时/超 CPU 限制），
// 多次调用（比如写个循环脚本反复 curl）直到 remaining 降到 0，全量照片就都打完分了
async function handleScorePhotos(request, env, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 20);

  // SQL 侧直接筛出待打分的 key + COUNT 统计，不再把整张 photo_scores 读进内存过滤
  // （回填没跑完之前 totalPhotos 不是 100% 准）
  const batch = await findUnscoredKeys(env, { limit });
  const scoredCount = await scoreKeys(env, batch);
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos_index WHERE type = 'image'").first();
  const remainRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM photos_index i LEFT JOIN photo_scores s ON s.key = i.key WHERE i.type = 'image' AND ${NEEDS_SCORE_SQL}`
  ).first();

  return new Response(
    JSON.stringify({
      scoredThisBatch: scoredCount,
      remaining: remainRow.n,
      totalPhotos: totalRow.n,
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

// 历史积压图片批量触发 Workflow，解决两个 backlog 场景：
//   1. 普通 JPEG 未打分：直接触发，Workflow step 3 打分
//   2. 历史 HEIC 无预览图（cron 只转今天的）：Workflow step 2 先转码，step 3 再打分
// 每次调用触发 limit 张（默认 50，上限 200），多次调用直到 remaining=0
async function handleBackfillWorkflows(request, env, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  // ORDER BY pi.key 保证分页顺序稳定；OFFSET 由调用方递增，每批推进一页，
  // 不受"照片是否已打完分"影响——循环的停止条件是"这一页已没有照片"而非 remaining=0。
  const { results } = await env.DB.prepare(
    "SELECT pi.key FROM photos_index pi " +
    "LEFT JOIN photo_scores ps ON pi.key = ps.key " +
    "WHERE pi.type = 'image' AND ps.key IS NULL " +
    "ORDER BY pi.key LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();

  // 用确定性实例 ID 避免同一照片被重复触发；已有运行中 Workflow 的照片 catch 住跳过
  let triggered = 0;
  for (const { key } of results) {
    const instanceId = ("bf-" + key).replace(/[^a-zA-Z0-9\-_]/g, "-").slice(0, 64);
    try {
      await env.PHOTO_WORKFLOW.create({ params: { key }, id: instanceId });
      triggered++;
    } catch {
      // 已有运行中的 Workflow 实例，跳过
    }
  }

  const remainRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM photos_index pi " +
    "LEFT JOIN photo_scores ps ON pi.key = ps.key " +
    "WHERE pi.type = 'image' AND ps.key IS NULL"
  ).first();

  // attempted: 本页实际取到的行数，调用方用它判断是否已翻到末尾（=0 则全部触发完毕）
  return Response.json({ triggered, attempted: results.length, remaining: remainRow.n });
}

// 管理端点：跟 /admin/score-photos 同样的批处理思路，把存量照片库的拍摄地点一次性查完。
// 因为要遵守 Nominatim 1 次/秒的限速，limit 故意给得比打分接口小一点，避免单次请求跑太久超时
async function handleLocatePhotos(request, env, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 20);

  // 同 /admin/score-photos：SQL 侧筛选 + COUNT，不把整张 photo_places 读进内存
  const batch = await findUnlocatedKeys(env, { limit });
  const processedCount = await enrichLocations(env, batch);
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos_index WHERE type = 'image'").first();
  const remainRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM photos_index i LEFT JOIN photo_places p ON p.key = i.key WHERE i.type = 'image' AND p.key IS NULL"
  ).first();

  return new Response(
    JSON.stringify({
      triggered: processedCount,
      remaining: remainRow.n,
      totalPhotos: totalRow.n,
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

// 在给定的 HEIC key 列表里找出还没生成预览版的（包括之前失败过、重试次数没到上限的），
// 最多转 limit 张（解码一张图比打分/查地点都重，单次调用别堆太多）。
// keys 的顺序就是优先级顺序——调用方负责把"今天"匹配到的排在前面
async function convertHeicBatch(env, heicKeys, limit) {
  const unconverted = [];
  for (const key of heicKeys) {
    if (unconverted.length >= limit * 3) break; // 找够候选就别再扫了，省子请求
    if (await needsHeicConversion(env, key)) unconverted.push(key);
  }
  const batch = unconverted.slice(0, limit);

  const errors = [];
  let converted = 0;
  for (const key of batch) {
    try {
      const did = await generateHeicPreview(env, key);
      if (did) converted++;
    } catch (err) {
      errors.push({ key, error: String(err && err.message ? err.message : err) });
    }
  }
  return { converted, errors };
}

// 管理端点：批量给 HEIC 照片生成 JPEG 预览版（服务端解码，需要 Workers Paid 套餐）
async function handleConvertHeicPhotos(request, env, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 3, 10);
  // 查 photos_index 而不是 listAll() 扫一遍 R2，省内存（回填没跑完之前 totalHeic 不是 100% 准）
  const { results } = await env.DB.prepare("SELECT key FROM photos_index WHERE key LIKE '%.HEIC' OR key LIKE '%.heic'").all();
  const heicKeys = results.map((r) => r.key);

  const { converted, errors } = await convertHeicBatch(env, heicKeys, limit);

  return new Response(
    JSON.stringify({ convertedThisBatch: converted, totalHeic: heicKeys.length, errors }),
    { headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

// 管理端点：清掉某个 month/day 的 /api/memories、/api/map-photos 边缘缓存。
// Workers Cache API 没有"按 URL 模式批量清"的接口，只能精确知道 cacheKey 长什么样再逐个 delete——
// 数据匹配逻辑（比如这次加 Live Photo 配对）改了之后，已经访问过的日期要等 30 分钟缓存自然过期才能看到新结果，
// 着急验证效果的时候用这个端点手动清一下
// origin 写死成正式域名——这个函数会被 queue() consumer 调用，那边没有 request/url 可以取 origin，
// 而这个项目本来就只绑定了这一个域名（见 wrangler.toml 的 routes），不会跑在别的域名上
const SITE_ORIGIN = "https://memories.cuijianzhuang.com";

async function purgeDayCache(month, day) {
  const cache = caches.default;
  // 前端请求永远显式带 lunar=0 / lunar=1（见 app.js loadMemories），边缘缓存按完整 URL 做 key，
  // 三个变体都要清——之前漏了 lunar=0，公历模式（最常用）的缓存一直清不掉，
  // 新照片上传后要干等边缘缓存自然过期（最长 30 分钟）才出现
  const targets = [
    `${SITE_ORIGIN}/api/memories?month=${month}&day=${day}`,
    `${SITE_ORIGIN}/api/memories?month=${month}&day=${day}&lunar=0`,
    `${SITE_ORIGIN}/api/memories?month=${month}&day=${day}&lunar=1`,
    `${SITE_ORIGIN}/api/map-photos?month=${month}&day=${day}`,
  ];
  const deleted = [];
  for (const target of targets) {
    const ok = await cache.delete(new Request(target));
    deleted.push({ url: target, deleted: ok });
  }
  return deleted;
}

async function handlePurgeCache(request, env, url) {
  const month = url.searchParams.get("month");
  const day = url.searchParams.get("day");
  if (!/^\d{2}$/.test(month || "") || !/^\d{2}$/.test(day || "")) {
    return new Response(JSON.stringify({ error: "month/day required, format MM/DD" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const deleted = await purgeDayCache(month, day);

  return new Response(JSON.stringify({ month, day, deleted }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// 一次性回填：把上线 R2 Event Notification 之前已经存在的旧文件补进 photos_index。
// 新上传的文件由 queue() consumer 增量维护，这个只用来补历史存量。Cron 里也会自动跑这个
// （见 runBackgroundMaintenance），跑到 remaining 降到 0 之后自然变成几乎不耗资源的空操作，
// 不用手动惦记着点——这个函数被 handleBackfillPhotosIndex（手动触发，想多补点）和
// Cron（自动慢慢补）两边共用
async function backfillPhotosIndexBatch(env, limit) {
  const allItems = await listAll(env.PHOTOS, BASE_PREFIX);
  const candidateKeys = allItems.map((obj) => obj.key).filter((key) => IMAGE_EXT.test(key) || VIDEO_EXT.test(key));

  const { results } = await env.DB.prepare("SELECT key FROM photos_index").all();
  const indexed = new Set(results.map((r) => r.key));
  const unindexed = candidateKeys.filter((key) => !indexed.has(key));
  const batch = unindexed.slice(0, limit);

  const objByKey = new Map(allItems.map((obj) => [obj.key, obj]));
  const errors = [];
  let indexedCount = 0;
  for (const key of batch) {
    try {
      const meta = await indexPhoto(env, key, objByKey.get(key));
      if (meta) {
        indexedCount++;
      } else {
        errors.push({ key, error: "拍不出拍摄日期或路径结构不符合预期，跳过" });
      }
    } catch (err) {
      errors.push({ key, error: String(err && err.message ? err.message : err) });
    }
  }

  return {
    indexedThisBatch: indexedCount,
    remaining: unindexed.length - batch.length,
    totalCandidates: candidateKeys.length,
    alreadyIndexed: indexed.size,
    errors,
  };
}

// 按新规则（年月日整体取拍摄日期，不再信备份路径）重算存量 photos_index 行的日期，
// 修正"6/14 拍的照片被记到 7 月"这类历史错行。改了的行顺手把新旧两天的缓存都清掉。
// Cron 每趟自动跑一批（见 runBackgroundMaintenance），手动端点可以随时加速
async function reindexPhotoDatesBatch(env, limit, offset) {
  const { results } = await env.DB.prepare(
    "SELECT key, year, month, day, size, uploaded FROM photos_index ORDER BY key LIMIT ? OFFSET ?"
  ).bind(limit, offset).all();

  const changes = [];
  const affectedDays = new Set();
  for (const row of results) {
    // size/uploaded 直接用索引里已有的值，文件名带日期的照片一次 R2 调用都不用发
    const meta = await computePhotoMeta(env, row.key, { size: row.size, uploaded: row.uploaded });
    if (!meta) continue;
    if (meta.year !== row.year || meta.month !== row.month || meta.day !== row.day) {
      await upsertPhotoIndex(env, meta);
      affectedDays.add(`${row.month}-${row.day}`);
      affectedDays.add(`${meta.month}-${meta.day}`);
      changes.push({ key: row.key, from: `${row.year}/${row.month}/${row.day}`, to: `${meta.year}/${meta.month}/${meta.day}` });
    }
  }
  for (const md of affectedDays) {
    const [m, d] = md.split("-");
    await purgeDayCache(m, d);
  }

  return {
    scanned: results.length,
    fixed: changes.length,
    nextOffset: results.length === limit ? offset + limit : null, // null = 扫完了
    changes,
  };
}

// 用法：/admin/reindex-photo-dates?token=xxx&limit=200&offset=0，返回 nextOffset 继续翻页
async function handleReindexPhotoDates(request, env, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const result = await reindexPhotoDatesBatch(env, limit, offset);

  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleBackfillPhotosIndex(request, env, url) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 300);
  const result = await backfillPhotosIndexBatch(env, limit);

  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---------- 运维控制台 API：状态总览 / 照片查询 / 数据修复 ----------
// 控制台页面在 public/admin-ops.html（/admin/ops 路由直出）。站点整体在 Cloudflare Access
// 后面，管理接口和相簿时期的决策一致：不再单独校验 token

// 系统状态总览：索引量、待打分/待查地点积压、推送队列、后台任务标记位
async function handleOpsStatus(request, env, url) {
  await ensureAuxTables(env);

  const [typeRows, unscored, unlocated, pendingNotify, notes, reactions, recent] = await Promise.all([
    env.DB.prepare("SELECT type, COUNT(*) AS c FROM photos_index GROUP BY type").all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM photos_index i LEFT JOIN photo_scores s ON s.key = i.key WHERE i.type = 'image' AND ${NEEDS_SCORE_SQL}`
    ).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS c FROM photos_index i LEFT JOIN photo_places p ON p.key = i.key WHERE i.type = 'image' AND p.key IS NULL"
    ).first(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM meta WHERE key LIKE 'notify:%'").first(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM photo_notes").first(),
    env.DB.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(count), 0) AS total FROM photo_reactions").first(),
    env.DB.prepare("SELECT key, year, month, day, type, updated_at FROM photos_index ORDER BY updated_at DESC LIMIT 8").all(),
  ]);

  const [backfillDoneAt, reindexDoneAt, reindexOffset, lastViewed] = await Promise.all([
    env.KV.get("backfill_done_at"),
    env.KV.get("reindex_dates_done_at"),
    env.KV.get("reindex_dates_offset"),
    getLastViewedDay(env),
  ]);

  const byType = {};
  for (const r of typeRows.results) byType[r.type] = r.c;

  return Response.json({
    now: new Date().toISOString(),
    bjToday: bjToday(),
    index: { total: Object.values(byType).reduce((a, b) => a + b, 0), byType },
    unscored: unscored?.c ?? 0,
    unlocated: unlocated?.c ?? 0,
    pendingNotify: pendingNotify?.c ?? 0,
    notes: notes?.c ?? 0,
    reactions: { rows: reactions?.c ?? 0, total: reactions?.total ?? 0 },
    flags: {
      backfill_done_at: backfillDoneAt || null,
      reindex_dates_done_at: reindexDoneAt || null,
      reindex_dates_offset: reindexOffset || null,
      last_viewed_day: lastViewed || null,
    },
    recentIndexed: recent.results,
  });
}

// GET ?q=子串   → 按 key 模糊搜索，最多 20 条
// GET ?key=完整key → 单张照片的全量数据（索引 / 打分 / 地点 / 手记 / 表态 / 原图是否还在 R2）
async function handlePhotoInfo(request, env, url) {
  await ensureAuxTables(env);

  const q = (url.searchParams.get("q") || "").trim();
  const key = url.searchParams.get("key");

  if (!key) {
    if (!q) return Response.json({ error: "q or key required" }, { status: 400 });
    const like = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    const { results } = await env.DB.prepare(
      "SELECT key, type, year, month, day FROM photos_index WHERE key LIKE ?1 ESCAPE '\\' ORDER BY year DESC, month DESC, day DESC LIMIT 20"
    ).bind(like).all();
    return Response.json({ matches: results });
  }

  const [index, score, place, note, reactions] = await Promise.all([
    env.DB.prepare("SELECT * FROM photos_index WHERE key = ?").bind(key).first(),
    env.DB.prepare("SELECT score, has_face, caption, updated_at FROM photo_scores WHERE key = ?").bind(key).first(),
    env.DB.prepare("SELECT lat, lon, name FROM photo_places WHERE key = ?").bind(key).first(),
    env.DB.prepare("SELECT note, updated_at FROM photo_notes WHERE key = ?").bind(key).first(),
    env.DB.prepare("SELECT emoji, count FROM photo_reactions WHERE key = ? AND count > 0").bind(key).all(),
  ]);
  const inR2 = !!(await env.PHOTOS.head(key));
  return Response.json({ key, inR2, index, score, place, note, reactions: reactions.results });
}

// POST body: { key, action, ... }。动作：
//   set-date  {year, month, day}  改拍摄日期（自动清新旧两天的边缘缓存）
//   rescore                        删打分并立即重打（AI 文案/评分不满意时用）
//   relocate                       删地点并立即重查（EXIF GPS → Mapbox 地名）
//   set-place {name}               手动改地点名（保留已有经纬度）
//   clear-note                     删手记
//   remove-index                   从索引移除（原图已删但索引残留、或不想展示这张时用）
async function handlePhotoFix(request, env, url) {
  await ensureAuxTables(env);

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  const key = typeof body.key === "string" ? body.key : "";
  if (!key) return Response.json({ error: "key required" }, { status: 400 });

  const row = await env.DB.prepare("SELECT year, month, day FROM photos_index WHERE key = ?").bind(key).first();

  if (body.action === "set-date") {
    if (!row) return Response.json({ error: "key not in index" }, { status: 404 });
    const { year, month, day } = body;
    if (!/^\d{4}$/.test(year || "") || !/^\d{2}$/.test(month || "") || !/^\d{2}$/.test(day || "")) {
      return Response.json({ error: "year/month/day required, format YYYY/MM/DD" }, { status: 400 });
    }
    await env.DB.prepare("UPDATE photos_index SET year = ?, month = ?, day = ?, updated_at = ? WHERE key = ?")
      .bind(year, month, day, new Date().toISOString(), key).run();
    await purgeDayCache(row.month, row.day);
    await purgeDayCache(month, day);
    // 注意：文件名/EXIF 本身带日期的照片，之后若重跑"日期重扫"会按解析结果覆盖这次手动修改
    return Response.json({ ok: true, from: `${row.year}/${row.month}/${row.day}`, to: `${year}/${month}/${day}` });
  }

  if (body.action === "rescore") {
    await env.DB.prepare("DELETE FROM photo_scores WHERE key = ?").bind(key).run();
    let error = null;
    try { await scoreKeys(env, [key]); } catch (err) { error = String((err && err.message) || err); }
    const score = await env.DB.prepare("SELECT score, caption FROM photo_scores WHERE key = ?").bind(key).first();
    if (row) await purgeDayCache(row.month, row.day);
    // score 为空 + error 为空 = AI 没跑成但没抛错（比如 HEIC 还没有预览图），留给 Cron 兜底重试
    return Response.json({ ok: true, score, error });
  }

  if (body.action === "relocate") {
    await env.DB.prepare("DELETE FROM photo_places WHERE key = ?").bind(key).run();
    await enrichLocations(env, [key]);
    const place = await env.DB.prepare("SELECT lat, lon, name FROM photo_places WHERE key = ?").bind(key).first();
    if (row) await purgeDayCache(row.month, row.day);
    return Response.json({ ok: true, place });
  }

  if (body.action === "set-place") {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    await env.DB.prepare(
      "INSERT INTO photo_places (key, lat, lon, name) VALUES (?, NULL, NULL, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name"
    ).bind(key, name).run();
    if (row) await purgeDayCache(row.month, row.day);
    return Response.json({ ok: true, name });
  }

  if (body.action === "clear-note") {
    await env.DB.prepare("DELETE FROM photo_notes WHERE key = ?").bind(key).run();
    return Response.json({ ok: true });
  }

  if (body.action === "remove-index") {
    const removed = await removePhotoIndex(env, key);
    if (removed) await purgeDayCache(removed.month, removed.day);
    return Response.json({ ok: true, removed });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}

// POST body: { flag: "backfill" | "reindex" }——删掉 KV 完成标记，
// 让 Cron 恢复对应的追赶任务（索引回填 / 日期重扫）
async function handleResetFlag(request, env, url) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  if (body.flag === "backfill") {
    await env.KV.delete("backfill_done_at");
    return Response.json({ ok: true, cleared: ["backfill_done_at"] });
  }
  if (body.flag === "reindex") {
    await env.KV.delete("reindex_dates_done_at");
    await env.KV.delete("reindex_dates_offset");
    return Response.json({ ok: true, cleared: ["reindex_dates_done_at", "reindex_dates_offset"] });
  }
  return Response.json({ error: "unknown flag" }, { status: 400 });
}

// ---------- 今日诗词：每天在页面上配一句应景的古诗词（jinrishici.com），跟"那年今日"主题搭一块 ----------
// token 永久有效，只要拿到一次就存进 KV——比 Cache API 好在：全局一份（不同 PoP 共享，不会重复申请），
// Worker 重启/冷启动后也不用再去 jinrishici.com 换一个新的
async function getJinrishiciToken(env) {
  const cached = await env.KV.get("jinrishici-token");
  if (cached) return cached;

  const resp = await fetch("https://v2.jinrishici.com/token");
  const data = await resp.json();
  const token = data.data;
  await env.KV.put("jinrishici-token", token);
  return token;
}

// 每日诗词：按"北京时间的今天"为 key，权威副本存 D1 meta 表——
// Workers Cache 是按机房隔离的，只用 Cache 的话不同大区当天会各自抽到不同句子，
// Telegram 推送里的句子也可能跟网页对不上。D1 全球一份，保证同一天全世界同一句；
// Cache API 降级为 L1，挡住同机房的重复读，避免每次页面访问都打 D1
async function getDailyPoem(env) {
  const bjToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // 北京时间 YYYY-MM-DD
  const cache = caches.default;
  const cacheKey = new Request("https://memories.internal/daily-poem/" + bjToday);
  const cached = await cache.match(cacheKey);
  if (cached) return await cached.json();

  const metaKey = `poem:${bjToday}`;
  let poem;
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(metaKey).first();
  if (row?.value) {
    poem = JSON.parse(row.value);
  } else {
    const token = await getJinrishiciToken(env);
    const resp = await fetch("https://v2.jinrishici.com/sentence", {
      headers: { "X-User-Token": token },
    });
    const data = await resp.json();
    poem = {
      content: data.data.content,
      title: data.data.origin.title,
      author: data.data.origin.author,
      dynasty: data.data.origin.dynasty,
    };
    // 并发时第一个写进去的胜出（INSERT OR IGNORE），写完重读一次，
    // 保证即使两个机房同时初始化，最终大家用的也是同一句
    await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .bind(metaKey, JSON.stringify(poem)).run();
    const winner = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(metaKey).first();
    if (winner?.value) poem = JSON.parse(winner.value);
    // 顺手清掉 7 天前的旧句子，meta 表不积灰（ISO 日期字典序可比）
    const cutoff = new Date(Date.now() + 8 * 60 * 60 * 1000 - 7 * 86400 * 1000).toISOString().slice(0, 10);
    await env.DB.prepare("DELETE FROM meta WHERE key LIKE 'poem:%' AND key < ?").bind(`poem:${cutoff}`).run();
  }

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(poem), {
      headers: { "content-type": "application/json", "cache-control": "max-age=86400" },
    })
  );
  return poem;
}

async function handlePoem(request, env, url) {
  try {
    const poem = await getDailyPoem(env);
    return new Response(JSON.stringify(poem), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  } catch {
    // 第三方接口挂了也别影响主页面，前端拿到 204 就什么都不显示
    return new Response(null, { status: 204 });
  }
}

// ---------- 历史上的今天：Wikimedia Feed API，给"那年今日"再配一层世界史坐标 ----------
// https://api.wikimedia.org/feed/v1/wikipedia/{lang}/onthisday/selected/{MM}/{DD}
// 中文维基优先（selected 是人工精选的大事记），条目太少或不可用时回退英文维基。
// 历史事件内容基本不变，边缘缓存 7 天；上游挂了返回 204，前端整块隐藏不影响主功能
async function handleOnThisDay(request, env, url) {
  const month = url.searchParams.get("month");
  const day = url.searchParams.get("day");
  if (!/^\d{2}$/.test(month || "") || !/^\d{2}$/.test(day || "")) {
    return new Response(JSON.stringify({ error: "month/day required, format MM/DD" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(`${SITE_ORIGIN}/api/onthisday?month=${month}&day=${day}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const fetchLang = async (lang) => {
    const resp = await fetch(`https://api.wikimedia.org/feed/v1/wikipedia/${lang}/onthisday/selected/${month}/${day}`, {
      // Wikimedia 要求带能标识来源的 UA，匿名调用有限速但配合 7 天缓存完全够用
      headers: { "user-agent": "memories-today/1.0 (https://memories.cuijianzhuang.com)", accept: "application/json" },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.selected || [])
      .filter((e) => e && typeof e.year === "number" && e.text)
      .map((e) => ({ year: e.year, text: e.text }));
  };

  try {
    let events = await fetchLang("zh");
    if (events.length < 3) {
      const en = await fetchLang("en");
      if (en.length > events.length) events = en;
    }
    if (events.length === 0) throw new Error("empty");
    events.sort((a, b) => b.year - a.year);
    events = events.slice(0, 12);

    const response = new Response(JSON.stringify({ month, day, events }), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=604800" },
    });
    await cache.put(cacheKey, response.clone());
    return response;
  } catch {
    return new Response(null, { status: 204 });
  }
}

// ---------- 地图页用的数据接口：把所有查到过经纬度的照片列出来，给前端打点 ----------
// 地图只展示某一天（默认今天）匹配到的照片，不是整个照片库——
// 跟 /api/memories 共用同一套日期匹配逻辑（matchPhotosForDay），并且同样做边缘缓存
async function handleMapPhotos(request, env, url) {
  const month = url.searchParams.get("month");
  const day = url.searchParams.get("day");

  // 不带 month/day = 全量模式：地球视角一次拿到所有带定位的照片（聚合渲染交给前端）
  if (!month && !day) {
    const cache = caches.default;
    const cacheKey = new Request(url.toString());
    const cachedResp = await cache.match(cacheKey);
    if (cachedResp) return cachedResp;

    const { results } = await env.DB.prepare(
      `SELECT pp.key AS key, pp.lat, pp.lon, pp.name, pi.year, pi.month, pi.day, pi.type
       FROM photo_places pp
       JOIN photos_index pi ON pi.key = pp.key
       WHERE pp.lat IS NOT NULL`
    ).all();
    const photos = results.map((r) => ({
      key: r.key,
      url: `/img/${encodeURIComponent(r.key)}`,
      type: r.type,
      lat: r.lat,
      lon: r.lon,
      name: r.name || "",
      year: r.year,
      month: r.month,
      day: r.day,
    }));
    const response = new Response(JSON.stringify({ photos }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=1800",
      },
    });
    await cache.put(cacheKey, response.clone());
    return response;
  }

  if (!/^\d{2}$/.test(month || "") || !/^\d{2}$/.test(day || "")) {
    return new Response(JSON.stringify({ error: "month/day required, format MM/DD" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cachedResp = await cache.match(cacheKey);
  if (cachedResp) return cachedResp;

  const matchedByYear = await matchPhotosForDay(env, month, day);
  const matchedKeys = matchedByYear.flatMap((y) => y.photos.map((p) => p.key));
  const places = await loadPlacesForKeys(env, matchedKeys);

  const photos = matchedByYear
    .flatMap((y) => y.photos)
    .map((p) => {
      const entry = places[p.key];
      if (!entry || typeof entry !== "object" || typeof entry.lat !== "number") return null;
      return {
        key: p.key,
        url: p.url,
        type: p.type,
        lat: entry.lat,
        lon: entry.lon,
        name: entry.name || "",
        year: p.year,
        // 跟全量模式对齐：详情卡的日期展示和"去看这一天"链接都要用到
        month,
        day,
      };
    })
    .filter(Boolean);

  const response = new Response(JSON.stringify({ month, day, photos }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=1800",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}

// ---------- 地图页：把所有带 GPS 的照片打点在地图上 ----------
// 这里用的 token 必须是 public token（pk. 开头），跟服务端反向地理编码用的 secret token 是两个东西，
// 因为这段代码会原样发到浏览器执行，secret token 绝对不能出现在这里
const MAP_HTML = (mapboxPublicToken) => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>足迹 · 那年今日</title>
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<link href="https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.css" rel="stylesheet" />
<script src="https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.js"></script>
<link rel="stylesheet" href="/map.css" />
</head>
<body>
  <a class="back-btn" href="/" title="回到回忆墙">
    <svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
  </a>
  <div id="map"></div>
  <div class="map-empty" id="mapEmpty">还没有带定位信息的照片<br />等后台任务慢慢解析，或跑一次 /admin/locate-photos</div>

<script>window.MAPBOX_TOKEN = ${JSON.stringify(mapboxPublicToken).replace(/<\//g, '<\\/')};</script>
<script src="/map.js" defer></script>
</body>
</html>`;

// ── Durable Object：实时共享房间 ─────────────────────────────────────────────────
// 每个日期（"MM-DD"）对应一个 DO 实例。家人同时打开同一天的回忆时：
//   · 页面顶部显示"👥 N 人在看"（按唯一用户去重，同一人多个 Tab 只算 1 人）
//   · 每张照片右下角有 ❤️ 按钮，点击全员实时看到计数增长
// 反应数持久化存在 DO Storage，换一天再回来还能看到。
// 用户身份：优先读 Cloudflare Access 注入的 Cf-Access-Authenticated-User-Email；
// 未启用 Access 时回退到随机 UUID，行为与之前一致（每条连接独立计数）。
export class MemoryRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    // Cloudflare Access 验证通过后会注入此 header；未启用时用随机 UUID 保持每连接独立
    const userId = request.headers.get("Cf-Access-Authenticated-User-Email")
      || crypto.randomUUID();
    // 邮箱用 MD5 生成 Gravatar hash；匿名 UUID 不走 Gravatar，hash 为空串
    const gravatarHash = userId.includes("@")
      ? createHash("md5").update(userId.toLowerCase().trim()).digest("hex")
      : "";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // tag[0]=userId 用于去重；tag[1]=gravatarHash 发给客户端拼 Gravatar URL
    this.state.acceptWebSocket(server, [userId, gravatarHash]);

    await this._migrateReactions();
    const reactions_v2 = await this._allReactions();
    // 首次有人进这个房间时，把整个房间的历史计数一次性回填进 D1 镜像（之后靠写入路径维护）。
    // 镜像表是功能上线后才开始积累的，不回填的话，老表态所在的日期只要没人再点一下，
    // 那些照片就永远进不了"全家最爱"的跨日期聚合——这就是之前统计偏少/漏照片的原因
    this._syncReactionsToD1(reactions_v2).catch(() => {});
    const my_reactions = (await this.state.storage.get(`mr:${userId}`)) || {};
    const { count, list } = this._usersInfo();
    server.send(JSON.stringify({ type: "init", count, reactions_v2, my_reactions, you: userId, list }));
    this._broadcast({ type: "users", count, list }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // 旧版把整个房间的表态挤在一个 "reactions_v2" key 里，DO 单 key 有 128KB 上限，
  // 照片数 × emoji 种类长年累积会顶到头。现在按照片拆成 rx:<photoKey> 独立 key，
  // 首次访问时把旧数据懒迁移过去。DO 的 input gate 保证 storage await 期间不插入
  // 其他事件，整段迁移事实上是原子的
  async _migrateReactions() {
    const legacy = await this.state.storage.get("reactions_v2");
    if (!legacy) return;
    const entries = Object.entries(legacy);
    // storage.put 批量写一次最多 128 个键值对，分批
    for (let i = 0; i < entries.length; i += 128) {
      const batch = {};
      for (const [k, v] of entries.slice(i, i + 128)) batch[`rx:${k}`] = v;
      await this.state.storage.put(batch);
    }
    await this.state.storage.delete("reactions_v2");
  }

  // 聚合所有 rx: key，拼回 {photoKey: {emoji: count}}——发给客户端的 init 消息
  // 字段名保持 reactions_v2 不变，前端无需任何改动
  async _allReactions() {
    const map = await this.state.storage.list({ prefix: "rx:" });
    const out = {};
    for (const [k, v] of map) out[k.slice(3)] = v;
    return out;
  }

  // 把本房间所有历史计数全量镜像进 D1（每个房间只做一次，之后由写入路径增量维护）。
  // 不放在 _migrateReactions 里是因为迁移在这个功能上线前就已经跑完的房间同样需要回填
  async _syncReactionsToD1(all) {
    try {
      if (await this.state.storage.get("d1_synced")) return;
      await ensureAuxTables(this.env);
      const stmts = [];
      for (const [key, counts] of Object.entries(all)) {
        for (const [emoji, count] of Object.entries(counts)) {
          if (count > 0) {
            stmts.push(
              this.env.DB.prepare(
                "INSERT INTO photo_reactions (key, emoji, count) VALUES (?, ?, ?) " +
                  "ON CONFLICT(key, emoji) DO UPDATE SET count = excluded.count"
              ).bind(key, emoji, count)
            );
          }
        }
      }
      // D1 batch 单次别塞太多语句，50 条一批
      for (let i = 0; i < stmts.length; i += 50) {
        await this.env.DB.batch(stmts.slice(i, i + 50));
      }
      await this.state.storage.put("d1_synced", 1);
    } catch (_) {
      // 回填失败不影响实时体验，下次有人进房间再试
    }
  }

  async webSocketMessage(ws, raw) {
    try {
      const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      const isReact = msg.type === "react";
      const isUnreact = msg.type === "unreact";
      if ((isReact || isUnreact) && typeof msg.key === "string" && msg.key.length < 300) {
        const VALID_EMOJIS = new Set(['👍','❤️','😍','😂','😮','😢','🔥','✨']);
        const emoji = VALID_EMOJIS.has(msg.emoji) ? msg.emoji : '❤️';
        const [userId] = this.state.getTags(ws);
        const mrKey = `mr:${userId}`;
        const myR = (await this.state.storage.get(mrKey)) || {};
        const mine = myR[msg.key] || [];
        const has = mine.includes(emoji);
        if (isReact ? has : !has) return; // 幂等：重复 react / 无中生有的 unreact 直接忽略
        const rxKey = `rx:${msg.key}`;
        const counts = (await this.state.storage.get(rxKey)) || {};
        if (isReact) {
          mine.push(emoji);
          counts[emoji] = (counts[emoji] || 0) + 1;
        } else {
          mine.splice(mine.indexOf(emoji), 1);
          counts[emoji] = Math.max(0, (counts[emoji] || 0) - 1);
        }
        myR[msg.key] = mine;
        await Promise.all([
          this.state.storage.put(mrKey, myR),
          this.state.storage.put(rxKey, counts),
        ]);
        this._broadcast({ type: "react", key: msg.key, emoji, count: counts[emoji] });
        // 计数镜像到 D1（"全家最爱"页面要跨所有日期房间聚合，DO 之间没法互相枚举，
        // 只能在写入时同步一份出去）。写绝对值幂等，失败不影响实时体验。
        // 镜像这张照片的全部 emoji 而不只这次点的那一个——否则照片有历史遗留的
        // 未镜像计数时（比如 ❤️×5 只在 DO 里），新点一个 👍 会让 D1 只有 👍:1，
        // "全家最爱"里这张照片的总数从 6 变成 1
        try {
          await ensureAuxTables(this.env);
          const stmts = Object.entries(counts).map(([em, c]) =>
            this.env.DB.prepare(
              "INSERT INTO photo_reactions (key, emoji, count) VALUES (?, ?, ?) " +
                "ON CONFLICT(key, emoji) DO UPDATE SET count = excluded.count"
            ).bind(msg.key, em, c)
          );
          if (stmts.length) await this.env.DB.batch(stmts);
        } catch (_) {}
      }
    } catch (_) {}
  }

  webSocketClose(ws) {
    const { count, list } = this._usersInfoExcluding(ws);
    this._broadcast({ type: "users", count, list }, ws);
  }

  webSocketError(ws) {
    const { count, list } = this._usersInfoExcluding(ws);
    this._broadcast({ type: "users", count, list }, ws);
  }

  // 返回 { count, list }，list 是 {id, hash} 对象数组，按唯一 userId 去重
  _usersInfo() {
    const seen = new Map(); // id -> hash
    for (const ws of this.state.getWebSockets()) {
      const [id, hash] = this.state.getTags(ws) || [];
      if (id && !seen.has(id)) seen.set(id, hash || "");
    }
    return { count: seen.size, list: [...seen].map(([id, hash]) => ({ id, hash })) };
  }

  // 排除某个连接后重算（该连接即将离开的场景）
  _usersInfoExcluding(excludeWs) {
    const seen = new Map();
    for (const ws of this.state.getWebSockets()) {
      if (ws === excludeWs) continue;
      const [id, hash] = this.state.getTags(ws) || [];
      if (id && !seen.has(id)) seen.set(id, hash || "");
    }
    return { count: seen.size, list: [...seen].map(([id, hash]) => ({ id, hash })) };
  }

  _broadcast(msg, excludeWs) {
    const txt = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws !== excludeWs) try { ws.send(txt); } catch (_) {}
    }
  }
}
// ────────────────────────────────────────────────────────────────────────────────
// PhotoProcessingWorkflow — 照片上传后的 5 步持久化处理流水线
//
// 触发：queue() 收到 R2 PutObject / CompleteMultipartUpload / CopyObject 通知
// 步骤：
//   1. index          — 写 photos_index，拿到 month/day/type
//   2. heic-convert   — HEIC 专属：先转 JPEG 预览图（跳过则打分会因无图失败）
//   3. ai-score       — 调 llava-1.5-7b 视觉模型打分 + 生成中文说明文字
//   4. enrich-location — EXIF GPS → Mapbox 反查地点名称，写 photo_places
//   5. purge-cache    — 清边缘缓存，让 /api/memories 立即反映新照片
//
// 每步独立持久化：某步失败时只重试该步，已完成的步骤不重来。
// 视频/非图片在步骤 1 之后直接 return，不走后续 AI 流程。
export class PhotoProcessingWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { key } = event.payload;

    // ── Step 1: 索引 ──────────────────────────────────────────────────────────
    // 加重试：R2 head() 或 D1 写入偶发网络超时会让步骤抛出，没有重试就直接 outcome:exception
    const meta = await step.do("index", {
      retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
    }, async () => {
      return await indexPhoto(this.env, key);
    });
    // 非图片（视频/live photo 等）不需要 AI 打分和地点
    if (!meta || meta.type !== "image") return;

    // ── Step 2: HEIC 转码（仅 HEIC 文件）────────────────────────────────────
    // 解决原 queue handler 的 exceededMemory 问题：把 HEIC 解码单独放在一步，
    // 内存预算全给它，完成后下一步打分直接读现成的 JPEG 预览图
    if (/\.heic$/i.test(key)) {
      await step.do("heic-convert", {
        retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
        timeout: "2 minutes",
      }, async () => {
        await convertHeicBatch(this.env, [key], 1);
      });
    }

    // ── Step 3: AI 打分 ───────────────────────────────────────────────────────
    // llava-1.5-7b 视觉模型：score(1-10) + hasFace + 中文说明文字
    // Workers AI 调用有时会超时，最多重试 3 次，间隔指数增长
    await step.do("ai-score", {
      retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
      timeout: "3 minutes",
    }, async () => {
      await scoreKeys(this.env, [key]);
    });

    // ── Step 4: GPS 反查地点 ─────────────────────────────────────────────────
    // 从 EXIF 读取经纬度 → Mapbox Geocoding API → 写 photo_places 表
    await step.do("enrich-location", {
      retries: { limit: 2, delay: "10 seconds" },
      timeout: "30 seconds",
    }, async () => {
      await enrichLocations(this.env, [key]);
    });

    // ── Step 5: 清边缘缓存 ───────────────────────────────────────────────────
    await step.do("purge-cache", {
      retries: { limit: 2, delay: "5 seconds" },
    }, async () => {
      await purgeDayCache(meta.month, meta.day);
    });

    // ── Step 6: 今天拍的照片登记进待推送队列 ─────────────────────────────────
    // 不在这里直接发 Telegram：批量上传会一张一条刷屏。只把 key 登记进 D1
    // （meta 表 notify: 前缀），由 */10 Cron 聚合成一条消息推送
    // （见 flushPendingNotifications）
    await step.do("queue-notify", {
      retries: { limit: 2, delay: "5 seconds" },
    }, async () => {
      const today = bjToday();
      if (meta.month === today.month && meta.day === today.day) {
        await this.env.DB.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind(`notify:${key}`, new Date().toISOString()).run();
      }
    });
  }
}
