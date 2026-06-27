/**
 * "那年今日" Cloudflare Worker
 * 路径结构: Photos/MobileBackup/iPhone/{年}/{月}/{文件}
 * 月份下没有按天分文件夹。文件名形如 IMG_20260627_123456.jpg 的靠文件名里的 YYYYMMDD 判断拍摄日期；
 * 像 IMG_1017.JPG 这种纯序号命名、文件名没有日期的，JPEG 读 EXIF DateTimeOriginal，其他格式回退用 R2 上传时间近似
 * 绑定: R2 bucket 需在 wrangler.toml 中绑定为 PHOTOS
 */

const IMAGE_EXT = /\.(jpe?g|png|heic|gif|webp)$/i;
const VIDEO_EXT = /\.(mov|mp4)$/i;
const BASE_PREFIX = "Photos/MobileBackup/iPhone/";
const DATE_IN_NAME = /(19|20)\d{6}/; // 文件名里是否带 YYYYMMDD 风格的日期

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/memories") {
      return handleMemories(request, env, url, ctx);
    }

    if (url.pathname.startsWith("/img/")) {
      return handleImage(request, env, url);
    }

    if (url.pathname === "/admin/score-photos") {
      return handleScorePhotos(request, env, url);
    }

    if (url.pathname === "/favicon.svg") {
      return new Response(FAVICON_SVG, {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

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

  // R2 的 list() 是 A 类操作（比 get 贵很多），同一天会被反复访问，
  // 用边缘缓存挡住重复请求，避免每次访问都重新扫一遍年份+整月文件
  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const cachedResp = await cache.match(cacheKey);
  if (cachedResp) return cachedResp;

  // 先列出所有年份目录
  const yearPrefixes = await listYears(env.PHOTOS);
  // AI 离线打分的结果（没跑过 /admin/score-photos 或某张图还没轮到时，对应分数就是 undefined）
  const scores = await loadScores(env.PHOTOS);

  const results = [];
  for (const year of yearPrefixes) {
    // 月份下没有按天分文件夹，列出整月再判断每个文件是否是当天拍的
    const prefix = `${BASE_PREFIX}${year}/${month}/`;
    const dateTag = `${year}${month}${day}`;
    const items = await listAll(env.PHOTOS, prefix);
    const candidates = items.filter((obj) => IMAGE_EXT.test(obj.key) || VIDEO_EXT.test(obj.key));

    const matched = await Promise.all(
      candidates.map(async (obj) => {
        const basename = obj.key.split("/").pop();
        if (DATE_IN_NAME.test(basename)) {
          // 文件名自带日期，直接字符串匹配
          return basename.includes(dateTag) ? obj : null;
        }
        // 文件名没有日期（如 IMG_1017.JPG），尝试读 EXIF 拍摄时间
        const md = await getCapturedMonthDay(env.PHOTOS, obj.key);
        return md && md.month === month && md.day === day ? obj : null;
      })
    );

    const photos = matched
      .filter(Boolean)
      .map((obj) => ({
        key: obj.key,
        url: `/img/${encodeURIComponent(obj.key)}`,
        type: VIDEO_EXT.test(obj.key) ? "video" : "image",
        size: obj.size,
        uploaded: obj.uploaded,
        score: scores[obj.key] ?? null,
      }))
      // 按文件名/上传时间排一下序，同一年的照片别再乱序出现
      .sort((a, b) => a.key.localeCompare(b.key));
    if (photos.length > 0) {
      results.push({ year, month, day, photos });
    }
  }

  results.sort((a, b) => Number(b.year) - Number(a.year));

  const response = new Response(JSON.stringify({ month, day, years: results }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=1800",
    },
  });
  await cache.put(cacheKey, response.clone());

  // 自动给"今天"匹配出来的照片打分（只是这一天的几张，不是全量库），
  // 用 waitUntil 放在响应返回之后跑，不会拖慢页面加载；视频不打分
  const todaysUnscoredImageKeys = results
    .flatMap((y) => y.photos)
    .filter((p) => p.type === "image" && p.score === null)
    .map((p) => p.key);
  if (ctx && todaysUnscoredImageKeys.length > 0) {
    ctx.waitUntil(scoreKeys(env, todaysUnscoredImageKeys));
  }

  return response;
}

// 列出 BASE_PREFIX 下的年份子目录（用 delimiter 实现"目录"语义）
async function listYears(bucket) {
  const years = new Set();
  let cursor;
  const yearRegex = new RegExp(`^${BASE_PREFIX.replace(/\//g, "\\/")}(\\d{4})\\/$`);
  do {
    const listing = await bucket.list({
      prefix: BASE_PREFIX,
      delimiter: "/",
      cursor,
    });
    for (const p of listing.delimitedPrefixes || []) {
      const m = p.match(yearRegex);
      if (m) years.add(m[1]);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return Array.from(years);
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

// 获取文件的拍摄日期（月/日）。JPEG 读 EXIF，其他格式回退用 R2 上传时间近似
// 用 Workers Cache API 缓存结果，避免无日期文件名的文件每次请求都重新读取/解析
async function getCapturedMonthDay(bucket, key) {
  const cache = caches.default;
  const cacheKey = new Request(`https://memories.internal/exif-cache/${encodeURIComponent(key)}`);

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  let result = null;
  if (/\.jpe?g$/i.test(key)) {
    result = await readJpegExifDate(bucket, key);
  }
  if (!result) {
    const head = await bucket.head(key);
    if (head && head.uploaded) {
      const d = new Date(head.uploaded);
      result = { month: String(d.getMonth() + 1).padStart(2, "0"), day: String(d.getDate()).padStart(2, "0") };
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
    if (!dateStr) return null;
    const m = dateStr.match(/^(\d{4}):(\d{2}):(\d{2})/);
    return m ? { month: m[2], day: m[3] } : null;
  } catch {
    return null;
  }
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
  await cache.put(cacheKey, response.clone());
  return response;
}

// ---------- AI 选片：用 Workers AI 给照片打"值不值得展示"的分，离线批处理，结果存进 R2 的一个 JSON 文件 ----------
const SCORES_KEY = "_meta/photo-scores.json";

async function loadScores(bucket) {
  const obj = await bucket.get(SCORES_KEY);
  if (!obj) return {};
  try {
    return await obj.json();
  } catch {
    return {};
  }
}

async function saveScores(bucket, scores) {
  await bucket.put(SCORES_KEY, JSON.stringify(scores), {
    httpMetadata: { contentType: "application/json" },
  });
}

// 真正调用 AI 给一张照片打分，失败就给个中庸分数兜底，不让它一直卡在"未打分"里反复重试
async function scoreOnePhoto(env, key) {
  try {
    const obj = await env.PHOTOS.get(key);
    if (!obj) return null;
    const buffer = await obj.arrayBuffer();
    const aiResult = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
      image: Array.from(new Uint8Array(buffer)),
      prompt:
        "Rate how memorable and worth keeping this personal photo is on a scale of 1 to 10 " +
        "(consider: clear faces, meaningful moments, scenery > blurry/accidental/duplicate-looking shots). " +
        "Reply with ONLY the number, nothing else.",
      max_tokens: 8,
    });
    const text = (aiResult && (aiResult.description || aiResult.response)) || "";
    const match = text.match(/\d+/);
    return match ? Math.max(1, Math.min(10, parseInt(match[0], 10))) : 5;
  } catch {
    return 5;
  }
}

// 给一批 key 打分并存回 R2（内部会跳过已经打过分的 key），返回这次实际打了几张
async function scoreKeys(env, keys) {
  const scores = await loadScores(env.PHOTOS);
  const toScore = keys.filter((key) => !(key in scores));
  for (const key of toScore) {
    scores[key] = await scoreOnePhoto(env, key);
  }
  if (toScore.length > 0) {
    await saveScores(env.PHOTOS, scores);
  }
  return toScore.length;
}

// 管理端点：每次调用只处理一小批未打分的照片（避免单次请求超时/超 CPU 限制），
// 多次调用（比如写个循环脚本反复 curl）直到 remaining 降到 0，全量照片就都打完分了
// 需要先用 `wrangler secret put ADMIN_TOKEN` 设置密钥，调用时带 ?token=xxx
async function handleScorePhotos(request, env, url) {
  const token = url.searchParams.get("token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

  const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 20);
  const scores = await loadScores(env.PHOTOS);

  const allItems = await listAll(env.PHOTOS, BASE_PREFIX);
  const imageKeys = allItems
    .map((obj) => obj.key)
    .filter((key) => IMAGE_EXT.test(key) && !VIDEO_EXT.test(key));
  const unscored = imageKeys.filter((key) => !(key in scores));
  const batch = unscored.slice(0, limit);

  const scoredCount = await scoreKeys(env, batch);

  return new Response(
    JSON.stringify({
      scoredThisBatch: scoredCount,
      remaining: unscored.length - scoredCount,
      totalPhotos: imageKeys.length,
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } }
  );
}

// ---------- 网站图标：倾斜的宝丽来相框 + 暖色光斑，呼应照片墙 + 林间阳光主题 ----------
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0a0a0a"/>
  <g transform="rotate(-7 32 32)">
    <rect x="14" y="11" width="36" height="42" rx="3" fill="#f5f5f0"/>
    <rect x="18" y="15" width="28" height="26" rx="1" fill="#1c1c1e"/>
    <circle cx="38" cy="22" r="9" fill="#ffd28a" opacity="0.9"/>
  </g>
</svg>`;

// ---------- 前端页面 ----------
const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>那年今日</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
  html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }
  body {
    font-family: "SF Pro Display", -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    background: #000;
    color: #f5f5f7;
    margin: 0;
    padding: 0 0 6rem;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    position: relative;
  }

  /* 林间阳光：温暖光斑缓慢漂移 + 透过叶缝的光束，叶子晃动带来的忽明忽暗用 flicker 模拟
     光斑铺满整页（随页面一起滚动），叶影视频则固定满屏，两者叠在一起覆盖整个页面而不只是头部 */
  .sunlight { pointer-events: none; z-index: 1; opacity: 0; transition: opacity 1.2s ease; }
  .sunlight.on { opacity: 1; }
  /* 开关打开瞬间，一道光斑斜着扫过整屏，模拟阳光突然透进林间的感觉 */
  .sun-sweep {
    position: fixed; inset: 0; pointer-events: none; z-index: 4; opacity: 0;
    background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.3) 47%, rgba(255,225,170,0.4) 50%, rgba(255,255,255,0.3) 53%, transparent 65%);
    transform: translateX(-130%) skewX(-8deg);
  }
  .sun-sweep.play { animation: sunSweepIn 1.1s ease; }
  @keyframes sunSweepIn {
    0% { transform: translateX(-130%) skewX(-8deg); opacity: 0; }
    12% { opacity: 1; }
    100% { transform: translateX(130%) skewX(-8deg); opacity: 0; }
  }
  .sunlight .glow {
    position: absolute; inset: 0; left: -20vw; right: -20vw;
    background:
      radial-gradient(circle at 30% 20%, rgba(255,221,150,0.16) 0%, transparent 22%),
      radial-gradient(circle at 65% 35%, rgba(255,200,120,0.12) 0%, transparent 18%),
      radial-gradient(circle at 45% 55%, rgba(255,235,180,0.10) 0%, transparent 16%);
    background-repeat: repeat-y;
    background-size: 100% 100vh;
    filter: blur(18px);
    mix-blend-mode: screen;
    animation: driftGlow 22s ease-in-out infinite, flicker 5s ease-in-out infinite;
  }
  .sunlight .video-layer { position: fixed; inset: 0; overflow: hidden; }
  #leafVideo {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; opacity: 0.4; mix-blend-mode: screen;
    filter: blur(1px) saturate(1.15);
  }
  @keyframes driftGlow {
    0%, 100% { transform: translate(0, 0) scale(1); }
    50% { transform: translate(3%, 2%) scale(1.05); }
  }
  @keyframes flicker {
    0%, 100% { opacity: 0.85; }
    30% { opacity: 1; }
    45% { opacity: 0.6; }
    70% { opacity: 0.95; }
  }
  header, #content, .lightbox, .toast { position: relative; z-index: 2; }
  header {
    position: relative;
    text-align: center;
    padding: 5.5rem 1.5rem 3.5rem;
  }
  /* 唤醒林间后背景变浅，文字、按钮自动换成深色，并加一点投影撑出对比度，免得糊在背景里看不清 */
  body.sun-on { color: #1c1c1e; }
  body.sun-on .eyebrow,
  body.sun-on .subtitle,
  body.sun-on h1,
  body.sun-on h1 .date,
  body.sun-on .year-title,
  body.sun-on .year-title .count,
  body.sun-on .sunlight-switch,
  body.sun-on .cell .frame-year,
  body.sun-on .empty,
  body.sun-on .lightbox-caption { color: #1c1c1e; text-shadow: 0 1px 8px rgba(255,255,255,0.5); }
  body.sun-on .play-memories,
  body.sun-on .date-toggle {
    color: #1c1c1e; background: rgba(255,255,255,0.65);
    box-shadow: 0 2px 10px rgba(0,0,0,0.18);
  }
  body.sun-on .play-memories:hover,
  body.sun-on .date-toggle:hover { background: rgba(255,255,255,0.85); }
  body.sun-on .switch .track { background: rgba(0,0,0,0.22); box-shadow: 0 1px 4px rgba(0,0,0,0.15); }
  body.sun-on .switch .track::before { background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }
  .header-controls {
    position: absolute; top: 1.3rem; right: 1.4rem;
    display: flex; align-items: center; gap: 0.85rem;
  }
  .date-toggle {
    width: 32px; height: 32px; border-radius: 50%; border: none;
    background: rgba(255,255,255,0.08); backdrop-filter: blur(10px);
    color: #98989d; cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: background 0.15s ease, color 0.15s ease; flex-shrink: 0;
  }
  .date-toggle:hover { background: rgba(255,255,255,0.16); color: #f5f5f7; }
  .date-toggle svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .date-picker {
    position: absolute; top: 3.9rem; right: 1.4rem; width: 230px;
    display: flex; flex-direction: column; gap: 0.7rem;
    background: rgba(30,30,32,0.92); backdrop-filter: blur(20px);
    padding: 1rem 1.1rem 1.1rem; border-radius: 16px;
    box-shadow: 0 16px 36px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06);
    z-index: 10; text-align: left;
    transform-origin: top right;
    opacity: 0; transform: scale(0.92) translateY(-6px);
    visibility: hidden; pointer-events: none;
    transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s;
  }
  .date-picker::before {
    content: ''; position: absolute; top: -5px; right: 22px;
    width: 10px; height: 10px; background: rgba(30,30,32,0.92);
    transform: rotate(45deg); border-radius: 2px;
  }
  .date-picker.open {
    opacity: 1; transform: scale(1) translateY(0);
    visibility: visible; pointer-events: auto;
  }
  .date-picker label {
    font-size: 0.72rem; color: #8a8a8f; letter-spacing: 0.04em;
    text-transform: uppercase; font-weight: 600;
  }
  .date-picker input[type="date"] {
    width: 100%; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 9px; color: #f5f5f7; padding: 0.5rem 0.6rem; font-size: 0.9rem;
    color-scheme: dark; transition: border-color 0.15s ease;
  }
  .date-picker input[type="date"]:focus { outline: none; border-color: #0a84ff; }
  .date-picker .row { display: flex; gap: 0.5rem; }
  .date-picker button {
    border: none; border-radius: 9px; cursor: pointer; font-weight: 600;
    font-size: 0.85rem; padding: 0.5rem 0.8rem; transition: background 0.15s ease, opacity 0.15s ease;
  }

  .sunlight-switch {
    display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;
    color: #8a8a8f; font-size: 0.7rem; letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .switch { position: relative; display: inline-block; width: 34px; height: 20px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .track {
    position: absolute; inset: 0; background: rgba(255,255,255,0.18); border-radius: 999px;
    cursor: pointer; transition: background 0.25s ease;
  }
  .switch .track::before {
    content: ''; position: absolute; left: 3px; top: 3px; width: 14px; height: 14px;
    background: #c7c7cc; border-radius: 50%; transition: transform 0.25s ease, background 0.25s ease;
  }
  .switch input:checked + .track { background: rgba(255,255,255,0.32); }
  .switch input:checked + .track::before { transform: translateX(14px); background: #f5f5f7; }
  .date-picker #datePickerGo { flex: 1; background: #0a84ff; color: #fff; }
  .date-picker #datePickerGo:hover { background: #2a93ff; }
  .date-picker #datePickerToday { background: rgba(255,255,255,0.08); color: #c7c7cc; }
  .date-picker #datePickerToday:hover { background: rgba(255,255,255,0.16); }
  .eyebrow {
    font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase;
    color: #86868b; margin-bottom: 0.6rem; font-weight: 500;
  }
  h1 {
    font-size: clamp(2.2rem, 5vw, 3.4rem); font-weight: 700; margin: 0;
    letter-spacing: -0.015em; line-height: 1.1;
  }
  h1 .date { color: #f5f5f7; font-weight: 700; }
  .subtitle {
    color: #98989d; font-size: 1.05rem; margin-top: 0.9rem; font-weight: 400;
    letter-spacing: -0.005em;
  }
  .year-block { max-width: 1100px; margin: 0 auto 3.4rem; padding: 0 1.6rem; }
  .year-title {
    font-size: 1.3rem; font-weight: 600; color: #f5f5f7; margin-bottom: 1.1rem;
    display: flex; align-items: baseline; gap: 0.55rem; letter-spacing: -0.01em;
  }
  .year-title .count { color: #6e6e73; font-size: 0.82rem; font-weight: 400; }
  .grid {
    display: flex; flex-wrap: wrap; align-items: flex-start;
    gap: 22px 18px; padding: 0.5rem 0.5rem 1.5rem;
    perspective: 900px;
  }
  .cell {
    --tilt-deg: 0;
    position: relative; display: block;
    cursor: pointer; background: #f5f5f0; border-radius: 3px;
    padding: 16px 10px 26px; box-shadow: 0 8px 20px rgba(0,0,0,0.5);
    transform-origin: top center;
    transform: rotate(calc(var(--tilt-deg) * 1deg));
    transform-style: preserve-3d; will-change: transform;
    animation: hangSway var(--sway-dur, 5s) ease-in-out infinite;
    animation-delay: var(--sway-delay, 0s);
    transition: box-shadow 0.22s ease, z-index 0s;
  }
  /* 图钉：用渐变 + 高光 + 投影模拟一颗小圆钉，把照片"钉"在墙上的感觉 */
  .cell::before {
    content: ''; position: absolute; top: 1px; left: 50%; z-index: 2;
    width: 12px; height: 12px; margin-left: -6px; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #ff8f7e 0%, #e84a3a 50%, #a8281c 100%);
    box-shadow: 0 2px 3px rgba(0,0,0,0.5), inset 0 1px 1px rgba(255,255,255,0.45);
  }
  .cell:hover { box-shadow: 0 16px 30px rgba(0,0,0,0.65); z-index: 5; }
  .cell.touching { animation-play-state: paused; transition: transform 0.08s linear, box-shadow 0.22s ease; }
  .cell:not(.touching) { transition: transform 0.5s ease, box-shadow 0.22s ease; }
  @keyframes hangSway {
    0%   { transform: rotate(calc(var(--tilt-deg) * 1deg - 4deg)) translateX(-3px); }
    50%  { transform: rotate(calc(var(--tilt-deg) * 1deg + 4deg)) translateX(3px); }
    100% { transform: rotate(calc(var(--tilt-deg) * 1deg - 4deg)) translateX(-3px); }
  }
  .cell .frame-inner { width: 100%; height: 100%; overflow: hidden; border-radius: 1px; background: #1c1c1e; }
  .cell img, .cell video {
    display: block; object-fit: cover; width: 100%; height: 100%;
    opacity: 0; transition: opacity 0.4s ease;
  }
  .cell img.loaded, .cell video.loaded { opacity: 1; }
  .cell .frame-year {
    position: absolute; left: 0; right: 0; bottom: 6px; text-align: center;
    color: #8a8a82; font-size: 0.62rem; letter-spacing: 0.04em; font-family: "Courier New", monospace;
  }
  .play-badge {
    position: absolute; right: 16px; bottom: 28px; color: #fff;
    font-size: 0.78rem; text-shadow: 0 1px 3px rgba(0,0,0,0.6);
  }
  /* 某年照片太多时，先只摆出精选的几张，剩下的折进"展开"按钮 */
  .cell.extra { display: none; }
  .grid.expanded .cell.extra { display: block; }
  .show-more-btn {
    display: block; margin: -0.6rem auto 0; background: rgba(255,255,255,0.07);
    border: none; color: #9a9a9e; padding: 0.5rem 1.1rem; border-radius: 980px;
    font-size: 0.8rem; cursor: pointer; transition: background 0.15s ease, color 0.15s ease;
  }
  .show-more-btn:hover { background: rgba(255,255,255,0.14); color: #f5f5f7; }
  body.sun-on .show-more-btn { color: #5a5a5e; background: rgba(0,0,0,0.06); }
  body.sun-on .show-more-btn:hover { background: rgba(0,0,0,0.12); color: #1c1c1e; }
  .empty {
    color: #6e6e73; padding: 5rem 0; text-align: center; font-size: 1rem;
    max-width: 1100px; margin: 0 auto;
  }

  .play-memories {
    position: absolute; top: 1.3rem; left: 1.4rem;
    width: 32px; height: 32px; border-radius: 50%; border: none;
    background: rgba(255,255,255,0.08); backdrop-filter: blur(10px);
    color: #98989d; display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
  }
  .play-memories svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .play-memories:hover { background: rgba(255,255,255,0.16); color: #f5f5f7; }
  .play-memories:disabled { opacity: 0.35; cursor: default; transform: none; }

  .lightbox {
    position: fixed; inset: 0; background: rgba(0,0,0,0.9);
    display: flex; align-items: center; justify-content: center; z-index: 50;
    padding: 2rem; opacity: 0; visibility: hidden; pointer-events: none;
    transition: opacity 0.25s ease;
  }
  .lightbox.open { opacity: 1; visibility: visible; pointer-events: auto; }
  .lightbox-stage { position: relative; max-width: 92vw; max-height: 88vh; }
  .lightbox-stage img, .lightbox-stage video {
    max-width: 92vw; max-height: 88vh; border-radius: 10px; display: block;
    opacity: 0; transition: opacity 0.4s ease, transform 0.4s ease;
  }
  .lightbox-stage img.fx-fade, .lightbox-stage video.fx-fade { transform: scale(0.96); }
  .lightbox-stage img.fx-zoom, .lightbox-stage video.fx-zoom { transform: scale(1.15); }
  .lightbox-stage img.fx-left, .lightbox-stage video.fx-left { transform: translateX(60px); }
  .lightbox-stage img.fx-right, .lightbox-stage video.fx-right { transform: translateX(-60px); }
  .lightbox-stage img.show, .lightbox-stage video.show { opacity: 1; transform: scale(1) translateX(0); }
  .lightbox-actions {
    position: absolute; top: 1rem; right: 1.2rem; z-index: 2;
    display: flex; gap: 0.5rem; align-items: center;
  }
  .lightbox-btn {
    width: 38px; height: 38px; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; cursor: pointer;
    background: rgba(255,255,255,0.1); backdrop-filter: blur(10px);
    color: #fff; border: none; text-decoration: none;
    transition: background 0.15s ease, transform 0.15s ease;
  }
  .lightbox-btn:hover { background: rgba(255,255,255,0.22); transform: scale(1.06); }
  .lightbox-btn svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .lightbox-btn.close svg { width: 16px; height: 16px; }
  .toast {
    position: fixed; bottom: 2.2rem; left: 50%; transform: translateX(-50%) translateY(10px);
    background: rgba(40,40,42,0.95); color: #fff; padding: 0.55rem 1.1rem; border-radius: 980px;
    font-size: 0.85rem; opacity: 0; pointer-events: none; transition: opacity 0.25s ease, transform 0.25s ease;
    z-index: 60;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .lightbox-caption {
    position: absolute; left: 50%; bottom: -2.2rem; transform: translateX(-50%);
    color: #8fa1b8; font-size: 0.8rem; white-space: nowrap;
  }
  .lightbox-nav {
    position: absolute; top: 50%; transform: translateY(-50%); color: #fff;
    font-size: 2rem; cursor: pointer; opacity: 0.55; padding: 0.5rem; user-select: none;
    transition: opacity 0.15s ease;
  }
  .lightbox-nav:hover { opacity: 1; }
  .lightbox-nav.prev { left: -3rem; }
  .lightbox-nav.next { right: -3rem; }

  #fingertip {
    position: fixed; top: 0; left: 0; width: 70px; height: 70px;
    border-radius: 50%; pointer-events: none; z-index: 3;
    background: radial-gradient(circle, rgba(255,255,255,0.35) 0%, rgba(255,221,150,0.15) 45%, transparent 75%);
    filter: blur(2px); opacity: 0; transition: opacity 0.3s ease;
  }

  @media (max-width: 640px) {
    #fingertip { display: none; }
    body { padding: 0 0 3rem; }
    header { padding: 3.2rem 1rem 2.2rem; }
    .subtitle { font-size: 0.85rem; }
    .year-block { padding: 0 1rem; }
    .grid { gap: 14px 10px; }
    .cell { width: 40vw !important; height: 40vw !important; }
    .lightbox { padding: 0.8rem; }
    .lightbox-stage img, .lightbox-stage video { max-width: 96vw; max-height: 78vh; }
    .lightbox-nav { font-size: 1.8rem; padding: 0.6rem; }
    .lightbox-nav.prev { left: 0.2rem; }
    .lightbox-nav.next { right: 0.2rem; }
    .lightbox-actions { top: 0.6rem; right: 0.8rem; }
    .lightbox-btn { width: 36px; height: 36px; }
    .lightbox-caption { bottom: -1.8rem; font-size: 0.72rem; }
    .header-controls { top: 0.9rem; right: 0.8rem; gap: 0.6rem; }
    .date-toggle, .sunlight-switch .switch { transform: scale(1.05); }
    .sunlight-switch span { display: none; }
    .play-memories { top: 0.9rem; left: 0.8rem; width: 34px; height: 34px; }
    .date-picker { top: 3.4rem; right: 0.8rem; left: 0.8rem; }
    .date-picker input[type="date"] { flex: 1; }
    .cell, .date-toggle, .play-memories, .play-memories button, .lightbox-btn, .lightbox-nav, .sunlight-switch .track {
      -webkit-tap-highlight-color: transparent;
    }
  }
</style>
</head>
<body>
  <div class="sunlight">
    <div class="glow"></div>
    <div class="video-layer">
      <video id="leafVideo" autoplay muted loop playsinline>
        <source src="https://image.cuijianzhuang.com/leaves.mp4" type="video/mp4" />
      </video>
    </div>
  </div>
  <div class="sun-sweep" id="sunSweep"></div>
  <header>
    <div class="eyebrow">回忆 · Memories</div>
    <h1 id="title">那年今日</h1>
    <div class="subtitle" id="subtitle">正在唤醒回忆</div>
    <button class="play-memories" id="playMemories" title="播放回忆" disabled>
      <svg id="playIconPlay" viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" stroke-linejoin="round"/></svg>
      <svg id="playIconPause" viewBox="0 0 24 24" style="display:none"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
    </button>
    <div class="header-controls">
      <div class="sunlight-switch">
        <span id="sunlightLabel">LET THE SUN IN</span>
        <label class="switch">
          <input type="checkbox" id="sunlightSwitch" checked />
          <span class="track"></span>
        </label>
      </div>
      <button class="date-toggle" id="dateToggle" title="查看某一天">
        <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>
      </button>
    </div>
    <audio id="ambientAudio" loop preload="none">
      <source src="https://image.cuijianzhuang.com/forest.mp3" type="audio/mpeg" />
    </audio>
    <div class="date-picker" id="datePicker">
      <label>查看某一天</label>
      <input type="date" id="datePickerInput" />
      <div class="row">
        <button id="datePickerToday">今天</button>
        <button id="datePickerGo">查看</button>
      </div>
    </div>
  </header>
  <div id="fingertip"></div>
  <div id="content"></div>

  <div class="lightbox" id="lightbox">
    <div class="lightbox-actions">
      <a class="lightbox-btn" id="lightboxShare" title="分享">
        <svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>
      </a>
      <a class="lightbox-btn" id="lightboxDownload" title="下载">
        <svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>
      </a>
      <span class="lightbox-btn close" id="lightboxClose" title="关闭">
        <svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
      </span>
    </div>
    <span class="lightbox-nav prev" id="navPrev">‹</span>
    <span class="lightbox-nav next" id="navNext">›</span>
    <div class="lightbox-stage">
      <div id="lightboxBody"></div>
      <div class="lightbox-caption" id="lightboxCaption"></div>
    </div>
  </div>
  <div class="toast" id="toast"></div>

<script>
  const params = new URLSearchParams(location.search);
  const now = new Date();
  const month = params.get('month') || String(now.getMonth() + 1).padStart(2, '0');
  const day = params.get('day') || String(now.getDate()).padStart(2, '0');

  // 隐藏的日历选择：点小日历图标展开，选好日期跳转到 ?month=&day=
  const dateToggle = document.getElementById('dateToggle');
  const datePicker = document.getElementById('datePicker');
  const datePickerInput = document.getElementById('datePickerInput');
  const datePickerGo = document.getElementById('datePickerGo');
  const datePickerToday = document.getElementById('datePickerToday');
  datePickerInput.value = now.getFullYear() + '-' + month + '-' + day;
  dateToggle.onclick = (e) => {
    e.stopPropagation();
    datePicker.classList.toggle('open');
  };
  datePickerGo.onclick = () => {
    const v = datePickerInput.value; // "YYYY-MM-DD"
    if (!v) return;
    const [, m, d] = v.split('-');
    location.href = location.pathname + '?month=' + m + '&day=' + d;
  };
  datePickerToday.onclick = () => { location.href = location.pathname; };
  document.addEventListener('click', (e) => {
    if (datePicker.classList.contains('open') && !datePicker.contains(e.target) && e.target !== dateToggle && !dateToggle.contains(e.target)) {
      datePicker.classList.remove('open');
    }
  });

  // "唤醒林间"开关：一个开关同时控制光斑视觉效果和林间环境音，默认开启
  // 浏览器禁止自动带声音播放，所以默认开启时光斑视觉照常显示，但声音要等用户第一次交互后才能真正响起
  const sunlight = document.querySelector('.sunlight');
  const sunSweep = document.getElementById('sunSweep');
  const ambientAudio = document.getElementById('ambientAudio');
  const sunlightSwitch = document.getElementById('sunlightSwitch');
  const sunlightLabel = document.getElementById('sunlightLabel');
  sunlightSwitch.checked = true;
  sunlightLabel.textContent = 'KEEP THE SUN OUT';
  document.body.classList.add('sun-on');
  sunlight.classList.add('on');
  ambientAudio.volume = 0.5;
  ambientAudio.play().catch(() => {});
  sunlightSwitch.onchange = () => {
    document.body.classList.toggle('sun-on', sunlightSwitch.checked);
    sunlight.classList.toggle('on', sunlightSwitch.checked);
    sunlightLabel.textContent = sunlightSwitch.checked ? 'KEEP THE SUN OUT' : 'LET THE SUN IN';
    if (sunlightSwitch.checked) {
      sunSweep.classList.remove('play');
      requestAnimationFrame(() => sunSweep.classList.add('play'));
      ambientAudio.volume = 0.5;
      ambientAudio.play().catch(() => {});
    } else {
      ambientAudio.pause();
    }
  };

  const lightbox = document.getElementById('lightbox');
  const lightboxBody = document.getElementById('lightboxBody');
  const lightboxCaption = document.getElementById('lightboxCaption');
  const lightboxDownload = document.getElementById('lightboxDownload');
  const lightboxShare = document.getElementById('lightboxShare');
  const playBtn = document.getElementById('playMemories');
  const playIconPlay = document.getElementById('playIconPlay');
  const playIconPause = document.getElementById('playIconPause');
  const toast = document.getElementById('toast');

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  let allPhotos = [];   // 扁平化的全部照片，按年份顺序
  let currentIndex = -1;
  let slideTimer = null;
  let autoPlaying = false;
  const EFFECTS = ['fx-fade', 'fx-zoom', 'fx-left', 'fx-right'];
  let lastEffect = -1;

  function pickEffect() {
    let i = Math.floor(Math.random() * EFFECTS.length);
    if (i === lastEffect) i = (i + 1) % EFFECTS.length;
    lastEffect = i;
    return EFFECTS[i];
  }

  function renderSlide(index) {
    const p = allPhotos[index];
    if (!p) return;
    currentIndex = index;
    lightboxCaption.textContent = p.year + ' 年';
    lightboxDownload.href = p.url + '?dl=1';
    lightboxDownload.download = p.key.split('/').pop();
    lightboxShare.dataset.url = location.origin + p.url;
    lightboxShare.dataset.year = p.year;

    const el = document.createElement(p.type === 'video' ? 'video' : 'img');
    el.className = pickEffect();
    if (p.type === 'video') {
      el.src = p.url;
      el.controls = !autoPlaying;
      el.muted = autoPlaying;
      el.autoplay = true;
      el.onended = () => { if (autoPlaying) nextSlide(); };
    } else {
      el.src = p.url;
    }
    lightboxBody.innerHTML = '';
    lightboxBody.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));

    clearTimeout(slideTimer);
    if (autoPlaying && p.type !== 'video') {
      slideTimer = setTimeout(nextSlide, 3000);
    }
  }

  function nextSlide() { renderSlide((currentIndex + 1) % allPhotos.length); }
  function prevSlide() { autoPlaying = false; stopAutoPlay(); renderSlide((currentIndex - 1 + allPhotos.length) % allPhotos.length); }

  function openLightbox(index, asSlideshow) {
    autoPlaying = !!asSlideshow;
    lightbox.classList.add('open');
    if (asSlideshow && lightbox.requestFullscreen) {
      lightbox.requestFullscreen().catch(() => {});
    }
    renderSlide(index);
  }
  function stopAutoPlay() {
    autoPlaying = false;
    clearTimeout(slideTimer);
    playIconPlay.style.display = '';
    playIconPause.style.display = 'none';
  }
  function closeLightbox() {
    lightbox.classList.remove('open');
    stopAutoPlay();
    lightboxBody.innerHTML = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && lightbox.classList.contains('open') && autoPlaying) closeLightbox();
  });

  document.getElementById('lightboxClose').onclick = closeLightbox;
  lightboxShare.onclick = async (e) => {
    e.preventDefault();
    const url = lightboxShare.dataset.url;
    const text = lightboxShare.dataset.year + ' 年的今天';
    if (navigator.share) {
      try { await navigator.share({ title: '那年今日', text, url }); }
      catch {} // 用户取消分享，静默忽略
    } else {
      try {
        await navigator.clipboard.writeText(url);
        showToast('链接已复制');
      } catch {
        showToast('复制失败，请手动复制链接');
      }
    }
  };
  document.getElementById('navPrev').onclick = (e) => { e.stopPropagation(); prevSlide(); };
  document.getElementById('navNext').onclick = (e) => { e.stopPropagation(); autoPlaying = false; nextSlide(); };
  lightbox.onclick = (e) => { if (e.target === lightbox) closeLightbox(); };
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') { autoPlaying = false; nextSlide(); }
    if (e.key === 'ArrowLeft') prevSlide();
  });

  // 移动端左右滑动切换，不用非得点那两个小箭头
  let touchStartX = 0, touchStartY = 0;
  lightbox.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    autoPlaying = false;
    if (dx < 0) nextSlide(); else prevSlide();
  }, { passive: true });
  playBtn.onclick = () => {
    if (allPhotos.length === 0) return;
    autoPlaying = true;
    playIconPlay.style.display = 'none';
    playIconPause.style.display = '';
    openLightbox(0, true);
  };

  // "指尖滑过"照片墙：不只是单张图响应鼠标，而是按距离衰减让指尖经过的几张照片联动倾斜，
  // 像一只手指划过墙面逐张拂过去的感觉；同时一个发光的指尖光点跟随鼠标，带一点缓冲延迟。
  const RIPPLE_RADIUS = 230;
  let pointerX = -9999, pointerY = -9999, pointerActive = false;
  let fingerX = -9999, fingerY = -9999;
  const fingertip = document.getElementById('fingertip');

  document.addEventListener('mousemove', (e) => {
    pointerX = e.clientX; pointerY = e.clientY; pointerActive = true;
  });
  document.addEventListener('mouseleave', () => { pointerActive = false; });

  // 只对视口附近（含一点缓冲）的照片做指尖联动计算，照片墙很长时也不用每帧遍历全部 cell
  const visibleCells = new Set();
  const cellObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visibleCells.add(entry.target);
      } else {
        visibleCells.delete(entry.target);
        entry.target.classList.remove('touching');
        entry.target.style.transform = '';
      }
    }
  }, { rootMargin: '200px' });

  function wallTick() {
    requestAnimationFrame(wallTick);

    // 指尖光点用 lerp 缓冲跟随，制造轻微的"跟手"延迟感
    fingerX += (pointerX - fingerX) * 0.18;
    fingerY += (pointerY - fingerY) * 0.18;
    if (fingertip) {
      fingertip.style.opacity = pointerActive ? '1' : '0';
      fingertip.style.transform = 'translate(' + fingerX + 'px,' + fingerY + 'px) translate(-50%,-50%)';
    }

    for (const cell of visibleCells) {
      const inner = cell.querySelector('.frame-inner') || cell;
      const rect = inner.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = pointerX - cx, dy = pointerY - cy;
      const dist = Math.hypot(dx, dy);

      if (pointerActive && dist < RIPPLE_RADIUS) {
        const factor = 1 - dist / RIPPLE_RADIUS; // 0~1，越近越强
        const px = dx / rect.width, py = dy / rect.height;
        const baseTilt = cell.style.getPropertyValue('--tilt-deg') || '0';
        cell.classList.add('touching');
        cell.style.transform =
          'rotate(' + baseTilt + 'deg) perspective(700px) ' +
          'rotateX(' + (-py * 18 * factor).toFixed(2) + 'deg) rotateY(' + (px * 18 * factor).toFixed(2) + 'deg) ' +
          'scale(' + (1 + 0.08 * factor).toFixed(3) + ')';
      } else if (cell.classList.contains('touching')) {
        cell.classList.remove('touching');
        cell.style.transform = '';
      }
    }
  }
  requestAnimationFrame(wallTick);

  fetch('/api/memories?month=' + month + '&day=' + day).then(r => r.json()).then(data => {
    document.getElementById('title').innerHTML = '<span class="date">' + data.month + '月' + data.day + '日</span>，那些年的此刻';
    const content = document.getElementById('content');
    const subtitle = document.getElementById('subtitle');
    if (!data.years.length) {
      subtitle.textContent = '这一天，还没有故事';
      content.innerHTML = '<div class="empty">去拍一张，留给未来的自己</div>';
      return;
    }
    const totalPhotos = data.years.reduce((s, y) => s + y.photos.length, 0);
    subtitle.textContent = '横跨 ' + data.years.length + ' 个年头，' + totalPhotos + ' 个瞬间';
    playBtn.disabled = false;

    allPhotos = [];
    data.years.forEach(y => y.photos.forEach(p => allPhotos.push({ ...p, year: y.year })));

    // 给每张图随机一个尺寸档位、轻微倾斜角度，再配一个随机的晃动周期和延迟，做出挂在墙上被风吹的参差感
    const SIZES = [150, 190, 230, 170, 210];
    function pickSize(seed) { return SIZES[seed % SIZES.length]; }
    function pickTilt(seed) { const angles = [-3, -1.5, 0, 1.5, 3]; return angles[seed % angles.length]; }

    // 一年的照片太多时，先精选一部分摆出来：视频优先收录，然后是 AI 打过分的高分照片，
    // 剩下名额（包括还没被 AI 打分的）按时间均匀抽样，保证不是"挤在某一段"，而是有代表性的几个瞬间
    const FEATURED_LIMIT = 10;
    function pickFeatured(photos, limit) {
      if (photos.length <= limit) return null; // null 表示不需要折叠，全部都是精选
      const featured = new Set();
      photos.forEach((p, i) => { if (p.type === 'video' && featured.size < limit) featured.add(i); });

      // AI 打分过的非视频照片，按分数从高到低优先收录
      const scoredIdx = photos
        .map((p, i) => ({ i, score: p.score }))
        .filter(({ i, score }) => !featured.has(i) && typeof score === 'number')
        .sort((a, b) => b.score - a.score);
      for (const { i } of scoredIdx) {
        if (featured.size >= limit) break;
        featured.add(i);
      }

      // 还没打分的照片（或者 AI 还没跑过），按时间均匀抽样补满剩下的名额
      const remainingIdx = photos.map((_, i) => i).filter((i) => !featured.has(i));
      const need = limit - featured.size;
      if (need > 0 && remainingIdx.length > 0) {
        const step = remainingIdx.length / need;
        for (let k = 0; k < need; k++) {
          featured.add(remainingIdx[Math.min(remainingIdx.length - 1, Math.floor(k * step))]);
        }
      }
      return featured;
    }

    window.toggleShowMore = function (btn) {
      const grid = btn.previousElementSibling;
      const expanded = grid.classList.toggle('expanded');
      const total = btn.dataset.total;
      btn.textContent = expanded ? '收起' : '展开查看全部 ' + total + ' 张 ›';
    };

    content.innerHTML = data.years.map(y => {
      const featured = pickFeatured(y.photos, FEATURED_LIMIT);
      const extraCount = featured ? y.photos.length - featured.size : 0;
      const cells = y.photos.map((p, pi) => {
        const flatIndex = allPhotos.findIndex(x => x.key === p.key);
        const size = pickSize(pi + y.year.charCodeAt(0));
        const tilt = pickTilt(pi);
        const swayDur = (4 + (pi % 4) * 0.7).toFixed(1);
        const swayDelay = ((pi % 5) * 0.5).toFixed(1);
        const style = \`width:\${size}px;height:\${size}px;--tilt-deg:\${tilt};--sway-dur:\${swayDur}s;--sway-delay:\${swayDelay}s;\`;
        const extraClass = featured && !featured.has(pi) ? ' extra' : '';
        return p.type === 'video'
          ? \`<div class="cell\${extraClass}" style="\${style}" onclick="openLightbox(\${flatIndex}, false)"><div class="frame-inner"><video src="\${p.url}#t=0.5" muted preload="metadata" onloadeddata="this.classList.add('loaded')"></video></div><span class="play-badge">▶ 视频</span><span class="frame-year">\${y.year}</span></div>\`
          : \`<div class="cell\${extraClass}" style="\${style}" onclick="openLightbox(\${flatIndex}, false)"><div class="frame-inner"><img src="\${p.url}" loading="lazy" onload="this.classList.add('loaded')" /></div><span class="frame-year">\${y.year}</span></div>\`;
      }).join('');
      const showMoreBtn = extraCount > 0
        ? \`<button class="show-more-btn" data-total="\${y.photos.length}" onclick="toggleShowMore(this)">展开查看全部 \${y.photos.length} 张 ›</button>\`
        : '';
      return \`
      <div class="year-block">
        <div class="year-title">\${y.year} 年 <span class="count">（\${y.photos.length} 份）</span></div>
        <div class="grid">\${cells}</div>
        \${showMoreBtn}
      </div>
    \`;
    }).join('');
    content.querySelectorAll('.cell').forEach((cell) => cellObserver.observe(cell));
  });
</script>
</body>
</html>`;
