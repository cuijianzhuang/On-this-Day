/**
 * "那年今日" Cloudflare Worker
 * 路径结构: Photos/MobileBackup/iPhone/{年}/{月}/{文件}
 * 月份下没有按天分文件夹。文件名形如 IMG_20260627_123456.jpg 的靠文件名里的 YYYYMMDD 判断拍摄日期；
 * 像 IMG_1017.JPG 这种纯序号命名、文件名没有日期的，JPEG 读 EXIF DateTimeOriginal，其他格式回退用 R2 上传时间近似
 * 绑定: R2 bucket 需在 wrangler.toml 中绑定为 PHOTOS
 *
 * HEIC 服务端转码需要 Workers Paid 套餐（CPU 时间限制更宽松，解码一张图动辄几百毫秒）
 */

import "./node-shims.js"; // 必须排在 libheif 之前，垫上它会用到的 __dirname 等 Node 全局变量

// Workers 不允许运行时动态编译 WASM 字节码（new WebAssembly.Module(bytes) 这种用法），
// 必须在部署时就编译好——所以不能用内嵌 base64、运行时自己 new Module 的 libheif-bundle.js，
// 改用 Wrangler 原生支持的 .wasm 文件导入（部署时编译好），再用 instantiateWasm 回调接进去
import libheifWasmModule from "libheif-js/libheif-wasm/libheif.wasm";
import libheifFactory from "libheif-js/libheif-wasm/libheif.js";
import heicDecodeLibFactory from "heic-decode/lib.js";
import jpegJs from "jpeg-js";

let cachedDecodeOne = null;
function getHeicDecodeOne() {
  if (!cachedDecodeOne) {
    const libheif = libheifFactory({
      instantiateWasm(imports, successCallback) {
        // 用 WebAssembly.instantiate()（异步 API）会在 libheif 的 embind 类注册跑到一半时被打断，
        // 报 "Cannot read properties of undefined (reading 'overloadTable')"——这是 libheif-js 这个
        // wasm 构建本身的问题（在纯 Node 环境下用同样的异步 API 也能复现），跟 Workers 没关系。
        // libheifWasmModule 已经是 Wrangler 部署时编译好的 Module，从已编译的 Module 同步 new
        // Instance 不算"运行时动态编译"，Workers 允许，而且能避开上面那个异步初始化的 bug
        const instance = new WebAssembly.Instance(libheifWasmModule, imports);
        return successCallback(instance, libheifWasmModule);
      },
    });
    cachedDecodeOne = heicDecodeLibFactory(libheif).one;
  }
  return cachedDecodeOne;
}

// 服务端把 HEIC 解码成原始像素，再用纯 JS 的 jpeg-js 编码成 JPEG——
// 这条链路只用得到普通 JS + WASM，没有依赖 Node 的 fs、也没有依赖浏览器的 Canvas，Workers 环境下能跑
async function decodeHeicToJpeg(buffer, quality = 85) {
  const decodeOne = getHeicDecodeOne();
  // heic-decode 内部会对 buffer 做迭代/展开，必须传 Uint8Array 而不是裸 ArrayBuffer
  const uint8Buffer = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const { width, height, data } = await decodeOne({ buffer: uint8Buffer });
  return jpegJs.encode({ data, width, height }, quality).data;
}


const IMAGE_EXT = /\.(jpe?g|png|heic|gif|webp)$/i;
const VIDEO_EXT = /\.(mov|mp4)$/i;
const BASE_PREFIX = "Photos/MobileBackup/iPhone/";

// 记录最近一次有人查看的 month/day（存在 D1 的 meta 表），给 Cron 任务做优先级参考
async function getLastViewedDay(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_viewed_day'").first();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function setLastViewedDay(env, month, day) {
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES ('last_viewed_day', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(JSON.stringify({ month, day }))
    .run();
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

    if (url.pathname === "/api/map-photos") {
      return handleMapPhotos(request, env, url);
    }

    if (url.pathname === "/api/poem") {
      return handlePoem(request, env, url);
    }

    if (url.pathname === "/api/upload-heic-preview" && request.method === "POST") {
      return handleUploadHeicPreview(request, env, url);
    }

    if (url.pathname === "/favicon.svg") {
      return new Response(FAVICON_SVG, {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    if (url.pathname === `/static/app-${APP_CSS_HASH}.css`) {
      return new Response(APP_CSS, {
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    if (url.pathname === `/static/app-${APP_JS_HASH}.js`) {
      return new Response(APP_JS, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    if (url.pathname === `/static/map-${MAP_CSS_HASH}.css`) {
      return new Response(MAP_CSS, {
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    if (url.pathname === `/static/map-${MAP_JS_HASH}.js`) {
      return new Response(MAP_JS, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/map") {
      return new Response(MAP_HTML(env.MAPBOX_PUBLIC_TOKEN || ""), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },

  // Cron 定时任务：每次只处理一小批未打分/未查地点的照片，跑在用户访问之外，
  // 不会跟页面请求共享同一次调用的子请求预算，自然就不会撞到 Workers 的子请求上限
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackgroundMaintenance(env));
  },

  // R2 Event Notification -> Queue 推过来的"文件变化"消息：新增/修改增量维护 photos_index，
  // 顺手把打分（AI 文案/值不值得展示）、查地点（EXIF GPS 反查地名）跑一遍——新照片一上传
  // 就处理好，不用等下一次 Cron（最多 10 分钟）才轮到。视频跳过打分/查地点（AI 打分要喂图片，
  // EXIF GPS 也只有 JPEG/HEIC 这两种格式在解析）。删除则把索引表、打分、查地点、配套 HEIC
  // 预览图一起清掉，不然"那年今日"还会接着展示一张已经不存在的照片。单条失败不 ack（让队列
  // 按退避重投），别因为一张图算不出拍摄日期/AI 调用超时就拖累同一批里的其他消息。
  // 处理完了顺手把这张照片对应那天的 /api/memories、/api/map-photos 边缘缓存清掉——
  // 不然页面还在用之前缓存的旧结果，看不出新增/删除的变化
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        const event = message.body;
        const key = event.object.key;
        if (event.action === "PutObject" || event.action === "CompleteMultipartUpload" || event.action === "CopyObject") {
          const meta = await indexPhoto(env, key);
          if (meta) {
            await purgeDayCache(meta.month, meta.day);
          }
          if (meta && meta.type === "image") {
            // HEIC 刚上传、还没有预览图的时候不在这里打分——打分要喂图片给模型，没预览图就得现场
            // 解码一次（几十 MB 原始像素），跟队列本身处理消息的内存预算叠在一起很容易把这次调用炸了
            // （exceededMemory）。有现成预览图、或者不是 HEIC 的，照常立刻打分；HEIC 没预览图的
            // 就先跳过，交给 Cron 那边节流过的 HEIC 转码流程，转完预览图后下次 Cron 自然会补打分
            const isHeicWithoutPreview = /\.heic$/i.test(key) && !(await findHeicPreviewKey(env, key));
            if (!isHeicWithoutPreview) {
              await scoreKeys(env, [key]);
            }
            await enrichLocations(env, [key]);
          }
        } else if (event.action === "DeleteObject" || event.action === "LifecycleDeletion") {
          const removed = await removePhotoIndex(env, key);
          if (removed) {
            await purgeDayCache(removed.month, removed.day);
          }
        }
        message.ack();
      } catch (err) {
        console.error("queue: failed to process", message.body, err);
        message.retry();
      }
    }
  },
};

async function runBackgroundMaintenance(env) {
  const BATCH_SIZE = 10;

  // 回填（listAll 扫全量 ~16000 张建一个大数组）跟 HEIC 解码（单张就能占几十 MB 原始像素）
  // 是这个函数里两个最吃内存的环节，干万不能凑到同一次调用里——上一次就是因为两个撞一起
  // 又把 Cron 炸了（exceededMemory）。按当前分钟单双轮流跑，保证它俩永远不同时出现
  const doBackfillThisTick = new Date().getMinutes() % 20 < 10;
  if (doBackfillThisTick) {
    // 自动把存量照片慢慢补进 photos_index，不用再手动一次次点 /admin/backfill-photos-index——
    // 跑到 remaining 降到 0 之后，这步本身就退化成"扫一遍发现没有新文件"的轻量操作，不用专门关掉
    await backfillPhotosIndexBatch(env, 300);
  }

  // 之前这里用 listAll() 扫一遍整个 R2 桶 + matchPhotosForDay() 对每个年份再扫一遍、
  // 并发读一批 EXIF——8000+ 张照片之后这套组合在 Cron 里稳定触发 exceededMemory，
  // 整个 Cron 任务直接被杀掉，打分/查地点/HEIC 转码全都没跑成。改成查 photos_index 表，
  // 候选池准不准全看回填有没有跑完——没跑完之前只是子集，跑完之后这里的"今天优先"就是完整覆盖了
  // （matchPhotosForDay 现在也改查这张表了，两边口径一致）
  const now = new Date();
  const realToday = { month: String(now.getMonth() + 1).padStart(2, "0"), day: String(now.getDate()).padStart(2, "0") };
  const lastViewed = await getLastViewedDay(env);

  // 优先级最高的永远是服务器的"今天"——手机刚拍完传上来的照片不该因为有人在翻看某个历史日期
  // 就一直排不上号；"最近在看的那一天"（可能是某个历史日期）也给一份优先，体验上更贴合
  const priorityDays = [realToday];
  if (lastViewed && (lastViewed.month !== realToday.month || lastViewed.day !== realToday.day)) {
    priorityDays.push(lastViewed);
  }

  const { results: allIndexed } = await env.DB.prepare("SELECT key, type FROM photos_index").all();
  const imageKeys = allIndexed.filter((r) => r.type === "image").map((r) => r.key);
  const prioritizedKeys = new Set();
  for (const { month, day } of priorityDays) {
    const { results: rows } = await env.DB.prepare(
      "SELECT key FROM photos_index WHERE month = ? AND day = ? AND type = 'image'"
    )
      .bind(month, day)
      .all();
    for (const row of rows) prioritizedKeys.add(row.key);
  }
  const restKeys = imageKeys.filter((key) => !prioritizedKeys.has(key));
  const prioritized = [...prioritizedKeys, ...restKeys];

  const scores = await loadScores(env);
  const needScore = prioritized.filter((key) => needsScoring(scores, key));
  // 跟队列消费者那边一样：没预览图的 HEIC 不在这里打分（打分要现场解码，好几张堆在同一次
  // Cron 调用里很容易把内存吃爆）。只检查前面一小段候选（head() 很便宜），凑够一批就够了
  const candidatesToCheck = needScore.slice(0, BATCH_SIZE * 3);
  const checked = await mapWithConcurrency(candidatesToCheck, 4, async (key) => {
    if (/\.heic$/i.test(key) && !(await findHeicPreviewKey(env, key))) return null;
    return key;
  });
  const unscored = checked.filter(Boolean).slice(0, BATCH_SIZE);
  if (unscored.length > 0) await scoreKeys(env, unscored);

  const places = await loadPlaces(env);
  const unlocated = prioritized.filter((key) => !(key in places)).slice(0, BATCH_SIZE);
  if (unlocated.length > 0) await enrichLocations(env, unlocated);

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

// 找出某个 month/day 匹配到的照片/视频（不含打分、地点等附加信息，那些是按场景分别合并的）。
// handleMemories 和"地图只看当天"功能共用同一份匹配逻辑，避免逻辑分叉
// 去掉扩展名的文件名，用来配对 Live Photo——iPhone 的 Live Photo 在 R2 里是两个独立文件，
// 同目录、文件名（去掉扩展名）完全相同的一张 HEIC/JPEG + 一段 MOV，例如
// IMG_1234.HEIC 配 IMG_1234.MOV
function basenameNoExt(key) {
  return key.split("/").pop().replace(/\.[^.]+$/, "");
}

// 把同一批文件（已经按 IMAGE_EXT/VIDEO_EXT 过滤过）按"去掉扩展名的文件名"分组，
// 配对成功的合并成一条 type: 'live' 记录（带 url 静态图 + videoUrl 配对视频），
// 没配对到的图片/视频各自按原来的 image/video 类型展示，不受影响
function pairLivePhotos(objs, year) {
  const byBase = new Map();
  for (const obj of objs) {
    const base = basenameNoExt(obj.key);
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

  const matchedByYear = await matchPhotosForDay(env, month, day);
  // 只查这一天命中的那几十张照片，不用把整张 photo_scores/photo_places 表都读出来——
  // 这两张表是跟着整个库的年头一起涨的，按 key 过滤之后查询成本只跟"今天"的照片数挂钩
  const matchedKeys = matchedByYear.flatMap((y) => y.photos.map((p) => p.key));
  // AI 离线打分的结果（没跑过 /admin/score-photos 或某张图还没轮到时，对应分数就是 undefined）
  const scores = await loadScoresForKeys(env, matchedKeys);
  // 拍摄地点（反向地理编码结果），同样是离线缓存，没查过的是 undefined，查过但没 GPS 信息的是空字符串
  const places = await loadPlacesForKeys(env, matchedKeys);

  const results = matchedByYear.map((y) => ({
    ...y,
    photos: y.photos.map((p) => {
      const { score, hasFace, caption } = scoreInfoOf(scores[p.key]);
      return { ...p, score, hasFace, caption, place: placeNameOf(places[p.key]) };
    }),
  }));

  const response = new Response(JSON.stringify({ month, day, years: results }), {
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

  const basename = key.split("/").pop();
  let day = null;
  const dateMatch = basename.match(/(19|20)\d{2}(\d{2})(\d{2})/); // YYYYMMDD，第二组是月第三组是日
  if (dateMatch) {
    day = dateMatch[3];
  } else {
    // 文件名没带日期，跟 matchPhotosForDay 用的是同一套兜底逻辑（EXIF 优先，没有就用 R2 上传时间）
    const md = await getCapturedMonthDay(env.PHOTOS, key);
    day = md ? md.day : null;
  }
  if (!day) return null; // 实在拿不到拍摄日，先不索引——下次事件重投或者再跑一次回填脚本还能补上

  return {
    key,
    type: VIDEO_EXT.test(key) ? "video" : "image",
    year: ym.year,
    month: ym.month,
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
  } else if (/\.heic$/i.test(key)) {
    // HEIC 容器结构跟 JPEG 完全不同，解析失败就静默放弃，走下面的上传时间兜底
    try {
      result = await readHeicExifDate(bucket, key);
    } catch {
      result = null;
    }
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
    return { month: m[2], day: m[3], lat: gps ? gps.lat : null, lon: gps ? gps.lon : null };
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
  // 简单校验一下确实是 JPEG（FF D8 开头），免得垫一些奇怪的内容进桶
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return new Response("Bad Request: not a JPEG", { status: 400 });
  }
  // 限制一下大小，浏览器端解码出来的预览图正常不会很大，避免有人故意传超大文件占地方
  if (buffer.length > 10 * 1024 * 1024) {
    return new Response("Payload Too Large", { status: 413 });
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

  const buffer = await object.arrayBuffer();
  try {
    const jpegBytes = await decodeHeicToJpeg(buffer);
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
  let key = decodeURIComponent(url.pathname.replace(/^\/thumb\//, ""));
  if (!key) return new Response("Bad Request", { status: 400 });

  // Images binding 不支持 HEIC 输入，直接转码一次太慢、而且每个访问者都要在浏览器里重新解码一遍。
  // 优先用本地脚本提前转好、存在 PREVIEWS 桶里的 JPEG 预览版；没有的话再退回去转发原图，让前端 heicFallback 兜底解码
  let bucket = env.PHOTOS;
  if (/\.heic$/i.test(key)) {
    const previewKey = await findHeicPreviewKey(env, key);
    if (previewKey) {
      key = previewKey; // 命中预览版，走下面正常的 Images binding 缩放流程，但要从 PREVIEWS 桶读
      bucket = env.PREVIEWS;
    } else {
      return handleImage(request, env, new URL(url.toString().replace("/thumb/", "/img/")));
    }
  }

  const width = Math.min(Math.max(Number(url.searchParams.get("w")) || 400, 1), 2000);
  const height = url.searchParams.get("h") ? Math.min(Math.max(Number(url.searchParams.get("h")), 1), 2000) : undefined;
  const quality = Math.min(Math.max(Number(url.searchParams.get("q")) || 75, 1), 100);
  const fit = url.searchParams.get("fit") || "scale-down";
  // 按浏览器 Accept 头协商更小的格式：同质量下 AVIF/WebP 比 JPEG 能再小 30%-50%，
  // 不支持的浏览器（Accept 里没带）照样拿 JPEG，不强求
  const format = pickThumbFormat(request);

  const cache = caches.default;
  // 缓存键要把协商出来的格式带上——边缘缓存本身不认 Vary，同一个 URL 不分格式存只会有一份，
  // 不加这个的话谁先访问谁的格式就会被缓存下来，错发给后来不支持那个格式的浏览器
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.set("_fmt", format);
  const cacheKey = new Request(cacheUrl.toString());
  const cachedResp = await cache.match(cacheKey);
  if (cachedResp) return cachedResp;

  const object = await bucket.get(key);
  if (!object) return new Response("Not Found", { status: 404 });

  try {
    // input() 要的是 ReadableStream，不是 ArrayBuffer；quality 要放在 output() 里，不是 transform()；
    // format 必须写成 "image/jpeg" 这种完整 MIME，不能只写 "jpeg" —— 这几处之前全写错了，导致每张图都转换失败
    const transformed = await env.IMAGES.input(object.body)
      .transform({ width, height, fit })
      .output({ format, quality });
    const tResp = transformed.response();
    const headers = new Headers(tResp.headers);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    const response = new Response(tResp.body, { status: tResp.status, headers });
    // cache.put() 只认 Vary: Accept-Encoding，塞别的值（包括 Accept）会直接抛 TypeError——
    // 之前在 clone 前就设了这个头，等于连缓存进去的那份也带着它，每次都在这步炸掉、
    // 掉进 catch 退回原图，缩略图转换/缓存整个失效。改成只在真正回给浏览器的这份上设
    const cachedResponse = response.clone();
    response.headers.set("vary", "Accept");
    await cache.put(cacheKey, cachedResponse);
    return response;
  } catch {
    // 转换失败（比如某些边界格式，或者协商出来的格式这次解不了）就回退原图，别让照片整个挂掉
    return handleImage(request, env, new URL(url.toString().replace("/thumb/", "/img/")));
  }
}

// 按 Accept 头挑一个浏览器实际支持的格式里最小的那个，挑不出来（没带 Accept，或者是没有
// image/avif、image/webp 的老浏览器/工具）就老实退回 JPEG
function pickThumbFormat(request) {
  const accept = request.headers.get("accept") || "";
  if (accept.includes("image/avif")) return "image/avif";
  if (accept.includes("image/webp")) return "image/webp";
  return "image/jpeg";
}

// ---------- AI 选片：用 Workers AI 给照片打"值不值得展示"的分，离线批处理，结果存进 D1 ----------
async function loadScores(env) {
  const { results } = await env.DB.prepare(
    "SELECT key, score, has_face, caption, raw_response, updated_at FROM photo_scores"
  ).all();
  const scores = {};
  for (const row of results) {
    scores[row.key] = {
      score: row.score,
      hasFace: !!row.has_face,
      caption: row.caption || "",
      rawResponse: row.raw_response || "",
      updatedAt: row.updated_at || "",
    };
  }
  return scores;
}

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
      return env.DB.prepare(
        `SELECT key, score, has_face, caption, raw_response, updated_at FROM photo_scores WHERE key IN (${placeholders})`
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
        rawResponse: row.raw_response || "",
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
  return await decodeHeicToJpeg(await obj.arrayBuffer());
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
  return entry || { score: null, hasFace: false, caption: "", rawResponse: "", updatedAt: "" };
}

// 之前打过分但还没补上 AI 文案的（caption 字段加得比打分晚），或者文案是翻译功能上线前
// 生成的英文老文案，都要算作"需要处理"，不然这批照片永远不会再被 scoreOnePhoto 碰到
function needsScoring(scores, key) {
  if (!(key in scores)) return true;
  const caption = scores[key].caption;
  return !caption || !/[一-鿿]/.test(caption);
}

// 给一批 key 打分并存进 D1（内部会跳过已经打过分+有文案的 key），返回这次实际处理了几张
async function scoreKeys(env, keys) {
  const scores = await loadScores(env);
  const toScore = keys.filter((key) => needsScoring(scores, key));
  for (const key of toScore) {
    const info = await scoreOnePhoto(env, key);
    if (info) await saveScore(env, key, info);
  }
  return toScore.length;
}

// ---------- 拍摄地点：从 EXIF GPS 反向地理编码成地名，离线批处理，结果存进 D1 ----------
async function loadPlaces(env) {
  const { results } = await env.DB.prepare("SELECT key, lat, lon, name FROM photo_places").all();
  const places = {};
  for (const row of results) {
    places[row.key] = { lat: row.lat, lon: row.lon, name: row.name || "" };
  }
  return places;
}

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
  const places = await loadPlaces(env);
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
// 需要先用 `wrangler secret put ADMIN_TOKEN` 设置密钥，调用时带 ?token=xxx
async function handleScorePhotos(request, env, url) {
  const token = url.searchParams.get("token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

  const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 20);
  const scores = await loadScores(env);

  // 查 photos_index 而不是 listAll() 扫一遍 R2——8000+ 张照片之后那样会把内存吃爆
  // （之前 Cron/这个端点都吃过 exceededMemory 这个亏）。回填没跑完之前 totalPhotos 不是 100% 准
  const { results } = await env.DB.prepare("SELECT key FROM photos_index WHERE type = 'image'").all();
  const imageKeys = results.map((r) => r.key);
  const unscored = imageKeys.filter((key) => needsScoring(scores, key));
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

// 管理端点：跟 /admin/score-photos 同样的批处理思路，把存量照片库的拍摄地点一次性查完。
// 因为要遵守 Nominatim 1 次/秒的限速，limit 故意给得比打分接口小一点，避免单次请求跑太久超时
async function handleLocatePhotos(request, env, url) {
  const token = url.searchParams.get("token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

  const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 20);
  const places = await loadPlaces(env);

  // 同 /admin/score-photos：查 photos_index 而不是 listAll() 扫一遍 R2，省内存
  const { results } = await env.DB.prepare("SELECT key FROM photos_index WHERE type = 'image'").all();
  const imageKeys = results.map((r) => r.key);
  const unlocated = imageKeys.filter((key) => !(key in places));
  const batch = unlocated.slice(0, limit);

  const processedCount = await enrichLocations(env, batch);

  return new Response(
    JSON.stringify({
      processedThisBatch: processedCount,
      remaining: unlocated.length - processedCount,
      totalPhotos: imageKeys.length,
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
  const token = url.searchParams.get("token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

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
  const targets = [
    `${SITE_ORIGIN}/api/memories?month=${month}&day=${day}`,
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
  const token = url.searchParams.get("token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

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

async function handleBackfillPhotosIndex(request, env, url) {
  const token = url.searchParams.get("token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 300);
  const result = await backfillPhotosIndexBatch(env, limit);

  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---------- 今日诗词：每天在页面上配一句应景的古诗词（jinrishici.com），跟"那年今日"主题搭一块 ----------
// token 永久有效，只要拿到一次就缓存住，不用每个请求都重新换
async function getJinrishiciToken() {
  const cache = caches.default;
  const cacheKey = new Request("https://memories.internal/jinrishici-token");
  const cached = await cache.match(cacheKey);
  if (cached) return await cached.text();

  const resp = await fetch("https://v2.jinrishici.com/token");
  const data = await resp.json();
  const token = data.data;
  await cache.put(
    cacheKey,
    new Response(token, { headers: { "cache-control": "max-age=31536000, immutable" } })
  );
  return token;
}

// 诗词本身按"今天的真实日期"缓存一份，一天之内重复访问不会重新调用第三方接口，
// 也不会让每个访问者都各自换到不同的句子——同一天看到的应该是同一句
async function getDailyPoem() {
  const cache = caches.default;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD（UTC），够用，不需要按时区精确到当地"今天"
  const cacheKey = new Request("https://memories.internal/daily-poem/" + today);
  const cached = await cache.match(cacheKey);
  if (cached) return await cached.json();

  const token = await getJinrishiciToken();
  const resp = await fetch("https://v2.jinrishici.com/sentence", {
    headers: { "X-User-Token": token },
  });
  const data = await resp.json();
  const poem = {
    content: data.data.content,
    title: data.data.origin.title,
    author: data.data.origin.author,
    dynasty: data.data.origin.dynasty,
  };
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
    const poem = await getDailyPoem();
    return new Response(JSON.stringify(poem), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  } catch {
    // 第三方接口挂了也别影响主页面，前端拿到 204 就什么都不显示
    return new Response(null, { status: 204 });
  }
}

// ---------- 地图页用的数据接口：把所有查到过经纬度的照片列出来，给前端打点 ----------
// 地图只展示某一天（默认今天）匹配到的照片，不是整个照片库——
// 跟 /api/memories 共用同一套日期匹配逻辑（matchPhotosForDay），并且同样做边缘缓存
async function handleMapPhotos(request, env, url) {
  const month = url.searchParams.get("month");
  const day = url.searchParams.get("day");
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

// ---------- 网站图标：倾斜的宝丽来相框 + 暖色光斑，呼应照片墙 + 林间阳光主题 ----------
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0a0a0a"/>
  <g transform="rotate(-7 32 32)">
    <rect x="14" y="11" width="36" height="42" rx="3" fill="#f5f5f0"/>
    <rect x="18" y="15" width="28" height="26" rx="1" fill="#1c1c1e"/>
    <circle cx="38" cy="22" r="9" fill="#ffd28a" opacity="0.9"/>
  </g>
</svg>`;

// ---------- 静态资源：把页面里原本内联的 CSS/JS 拆出来，按内容算个指纹挂在 URL 上长期强缓存 ----------
// 之前 HTML/MAP_HTML 整页都是 no-store（保证内容跟着每次部署更新），代价是几十 KB 的 CSS/JS
// 每次切日期/每次访问都要重新传一遍。拆出来之后页面本体还是 no-store（永远拿到最新的资源链接），
// 但 CSS/JS 本身按内容 hash 出一个不会变的 URL，可以 immutable 缓存一整年——内容没变 hash 就不变，
// 浏览器命中本地缓存直接不发请求；内容变了 hash 跟着变，又不会有缓存不过期吃到旧版本的问题
function fingerprint(str) {
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const MAP_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #000; color: #f5f5f7;
    font-family: "SF Pro Display", -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  }
  #map { position: fixed; inset: 0; }
  .back-btn {
    position: absolute; top: 1.3rem; left: 1.4rem; z-index: 5;
    width: 36px; height: 36px; border-radius: 50%; border: none;
    background: rgba(20,20,22,0.8); backdrop-filter: blur(10px); color: #f5f5f7;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
    text-decoration: none; box-shadow: 0 4px 14px rgba(0,0,0,0.4);
  }
  .back-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .map-empty {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 5;
    color: #8a8a8f; font-size: 0.95rem; text-align: center; display: none;
  }
  .mapboxgl-popup-content {
    position: relative; background: rgba(24,24,26,0.96); color: #f5f5f7; border-radius: 12px; padding: 0;
    overflow: hidden; box-shadow: 0 12px 30px rgba(0,0,0,0.5);
  }
  .popup-photo { width: 180px; height: 180px; object-fit: cover; display: block; opacity: 0; transition: opacity 0.3s ease; }
  .popup-photo.loaded { opacity: 1; }
  .mapboxgl-popup-content::after {
    content: ''; position: absolute; top: 90px; left: 90px; width: 26px; height: 26px;
    margin: -13px 0 0 -13px; border-radius: 50%;
    border: 3px solid rgba(255,143,126,0.25); border-top-color: #ff8f7e;
    animation: spin 0.8s linear infinite;
    opacity: 1; transition: opacity 0.25s ease;
  }
  .mapboxgl-popup-content:has(.popup-photo.loaded)::after { opacity: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .popup-caption { padding: 0.5rem 0.7rem; font-size: 0.78rem; color: #c7c7cc; }
  .mapboxgl-popup-close-button { color: #fff; font-size: 1.1rem; padding: 0.2rem 0.5rem; }
  .mapboxgl-ctrl-attrib { font-size: 0.65rem; }
`;
const MAP_JS = `
  // 拼 HTML 字符串时用来转义属性值，避免文件名/路径里万一带了引号之类的字符把属性或内嵌脚本弄断
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

  // 缩放失败时的兜底：非 HEIC 文件直接换成原图（浏览器本来就能显示），
  // 只有 HEIC 才需要在浏览器里用 heic2any 现场解码
  window.heicFallback = async function (imgEl, originalUrl) {
    if (!/\.heic$/i.test(originalUrl)) {
      imgEl.src = originalUrl;
      return;
    }
    try {
      const resp = await fetch(originalUrl);
      const blob = await resp.blob();
      const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.85 });
      const previewBlob = Array.isArray(converted) ? converted[0] : converted;
      imgEl.src = URL.createObjectURL(previewBlob);
      // 顺手把现场解码的结果回传存进 PREVIEWS 桶，下次别的访问者就不用再解码一遍了
      const heicKey = originalUrl.replace('/img/', '');
      fetch('/api/upload-heic-preview?key=' + heicKey, { method: 'POST', body: previewBlob }).catch(() => {});
    } catch {
      // 实在解不出来就放弃
    }
  };

  // 跟主页一样，month/day 由前端按本地时间传入，避免 Worker 跑在 UTC 算错"今天"；
  // 没带参数时默认今天，地图只展示这一天匹配到的照片，不是整个照片库
  const mapParams = new URLSearchParams(location.search);
  const mapNow = new Date();
  const mapMonth = mapParams.get('month') || String(mapNow.getMonth() + 1).padStart(2, '0');
  const mapDay = mapParams.get('day') || String(mapNow.getDate()).padStart(2, '0');

  mapboxgl.accessToken = window.MAPBOX_TOKEN;
  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [108, 34],
    zoom: 2.4,
  });

  fetch('/api/map-photos?month=' + mapMonth + '&day=' + mapDay).then(r => r.json()).then(data => {
    const photos = data.photos || [];
    if (photos.length === 0) {
      document.getElementById('mapEmpty').style.display = 'block';
      return;
    }

    let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    photos.forEach(p => {
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);

      const el = document.createElement('div');
      el.style.width = '14px';
      el.style.height = '14px';
      el.style.borderRadius = '50%';
      el.style.background = '#ff8f7e';
      el.style.boxShadow = '0 0 0 3px rgba(255,143,126,0.3), 0 2px 6px rgba(0,0,0,0.5)';
      el.style.cursor = 'pointer';

      // 鼠标移上去就展示照片，不用再点一下；移开自动收起。缩略图走 Cloudflare Images binding 要小图
      // 视频不能走 /thumb/（Images binding 不支持视频输入，转换会失败兜底回原始视频字节，套进 <img> 只会裂图），
      // 直接用 <video> 标签播放原始文件取第一帧
      // 原图地址放进 data-src 属性，onerror 只读属性、不直接拼 JS 字符串，文件名里有特殊字符也不会把内嵌脚本弄断
      const popupThumbSrc = p.url.replace('/img/', '/thumb/') + '?w=360&h=360&q=75&fit=cover';
      // 用反引号拼，里面随便写单引号不用转义——这一段本身又被包在 worker.js 外层的反引号模板字符串里，
      // 之前用单引号拼字符串再写 \\'loaded\\' 转义，外层模板字符串会先把这个转义吃掉变成裸的单引号，
      // 提前把发到客户端的字符串截断，导致一上线点开地图就直接报 SyntaxError
      const popupMedia = p.type === 'video'
        ? \`<video class="popup-photo loaded" src="\${escAttr(p.url)}#t=0.5" muted preload="metadata"></video>\`
        : \`<img class="popup-photo" src="\${escAttr(popupThumbSrc)}" data-src="\${escAttr(p.url)}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.onerror=null;heicFallback(this,this.dataset.src)" />\`;
      const popup = new mapboxgl.Popup({ offset: 14, maxWidth: '200px', closeButton: false, closeOnClick: false }).setHTML(
        popupMedia +
        '<div class="popup-caption">' + (p.year || '') + (p.name ? ' · ' + p.name : '') + '</div>'
      );
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
      el.addEventListener('mouseenter', () => popup.setLngLat([p.lon, p.lat]).addTo(map));
      el.addEventListener('mouseleave', () => popup.remove());
    });

    if (photos.length === 1) {
      map.jumpTo({ center: [photos[0].lon, photos[0].lat], zoom: 9 });
    } else {
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 60, maxZoom: 12 });
    }
  });
`;
const APP_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; user-select: none; -webkit-user-select: none; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
  /* overflow-x:hidden 只放 body 上——同时加在 html 上是已知的 iOS Safari 坑，会把纵向滚动整个搞坏 */
  body { overflow-x: hidden; }
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
  #content, .lightbox, .toast { position: relative; z-index: 2; }
  /* header 的 z-index 必须比 #content 高：日历弹窗内容长的时候会超出 header 自身高度往下延伸，
     如果跟 #content 同级（z-index 相同时按 DOM 顺序，#content 在后面会盖在上面），
     延伸出去的那部分弹窗就会被加载出来的照片墙盖住、点不到 */
  header { position: relative; z-index: 20; }
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
  body.sun-on .daily-poem,
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
  .date-toggle:disabled { opacity: 0.35; cursor: default; }
  .date-toggle:disabled:hover { background: rgba(255,255,255,0.08); }
  .date-toggle svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .date-picker {
    position: absolute; top: 3.9rem; right: 1.4rem; width: 268px;
    display: flex; flex-direction: column; gap: 0.7rem;
    background: rgba(24,24,26,0.98);
    padding: 1rem 1.1rem 1.1rem; border-radius: 16px;
    box-shadow: 0 16px 36px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06);
    z-index: 10; text-align: left; isolation: isolate;
    transform-origin: top right;
    opacity: 0; transform: scale(0.92) translateY(-6px);
    visibility: hidden; pointer-events: none;
    transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s;
  }
  .date-picker::before {
    content: ''; position: absolute; top: -5px; right: 22px;
    width: 10px; height: 10px; background: rgba(24,24,26,0.98);
    transform: rotate(45deg); border-radius: 2px;
  }
  .date-picker.open {
    opacity: 1; transform: scale(1) translateY(0);
    visibility: visible; pointer-events: auto;
  }
  .year-menu {
    position: absolute; top: 3.9rem; right: 1.4rem; min-width: 180px;
    background: rgba(24,24,26,0.98); border-radius: 16px; padding: 0.4rem;
    box-shadow: 0 16px 36px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06);
    z-index: 10; isolation: isolate; transform-origin: top right;
    opacity: 0; transform: scale(0.92) translateY(-6px);
    visibility: hidden; pointer-events: none;
    transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s;
  }
  .year-menu.open { opacity: 1; transform: scale(1) translateY(0); visibility: visible; pointer-events: auto; }
  .year-menu button {
    display: flex; align-items: baseline; gap: 0.5rem; width: 100%; text-align: left;
    background: none; border: none; padding: 0.55rem 0.8rem; cursor: pointer;
    border-radius: 10px; color: #f5f5f7; font-family: inherit; transition: background 0.15s ease;
    opacity: 0; transform: translateY(6px);
  }
  /* 列表项不是一次性全部弹出来，每一项错开一点时间依次浮现，靠 JS 给每个按钮算好的 animation-delay 错开节奏 */
  .year-menu.open button { animation: yearItemIn 0.32s ease forwards; }
  @keyframes yearItemIn { to { opacity: 1; transform: translateY(0); } }
  .year-menu button:hover { background: rgba(255,255,255,0.08); }
  .year-menu button .y { font-weight: 600; font-size: 0.92rem; }
  .year-menu button .c { font-size: 0.72rem; color: #8a8a8f; font-family: 'Space Grotesk', sans-serif; }
  body.sun-on .year-menu { background: rgba(255,255,255,0.96); }
  body.sun-on .year-menu button { color: #1c1c1e; }
  body.sun-on .year-menu button:hover { background: rgba(0,0,0,0.06); }
  body.sun-on .year-menu button .c { color: #6e6e73; }
  .cal-header { display: flex; align-items: center; justify-content: space-between; }
  .cal-header .cal-month-label {
    font-size: 0.85rem; font-weight: 600; color: #f5f5f7; letter-spacing: -0.005em;
  }
  .cal-nav-btn {
    width: 24px; height: 24px; border-radius: 50%; border: none;
    background: rgba(255,255,255,0.07); color: #c7c7cc; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.85rem; line-height: 1; transition: background 0.15s ease;
  }
  .cal-nav-btn:hover { background: rgba(255,255,255,0.16); color: #f5f5f7; }
  .cal-weekdays, .cal-grid {
    display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center;
  }
  .cal-weekdays span { font-size: 0.68rem; color: #6e6e73; padding: 0.2rem 0; }
  .cal-grid button {
    aspect-ratio: 1; width: 100%; border: none; border-radius: 50%; background: transparent;
    color: #d6d6da; font-size: 0.78rem; cursor: pointer; transition: background 0.15s ease, color 0.15s ease;
  }
  .cal-grid button:disabled { visibility: hidden; cursor: default; }
  .cal-grid button:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
  .cal-grid button.today { color: #0a84ff; font-weight: 700; }
  .cal-grid button.selected { background: #0a84ff; color: #fff; }
  .date-picker .row { display: flex; gap: 0.5rem; }
  .date-picker .action-btn {
    display: flex; align-items: center; justify-content: center;
    border: none; border-radius: 9px; cursor: pointer; font-weight: 600;
    font-size: 0.85rem; padding: 0.5rem 0.8rem; transition: background 0.15s ease, opacity 0.15s ease;
    text-decoration: none;
  }

  .sunlight-switch {
    display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0;
    color: #8a8a8f; font-family: 'Space Grotesk', sans-serif; font-size: 0.7rem;
    letter-spacing: 0.22em; font-weight: 500; text-transform: uppercase;
  }
  .switch { position: relative; display: inline-block; width: 46px; height: 26px; flex-shrink: 0; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch .track {
    position: absolute; inset: 0; background: rgba(255,255,255,0.22); border-radius: 13px;
    cursor: pointer; transition: background 0.3s ease;
    box-shadow: inset 0 1px 3px rgba(0,0,0,0.22);
  }
  .switch .track::before {
    content: ''; position: absolute; left: 3px; top: 3px; width: 20px; height: 20px;
    background: #fff; border-radius: 50%; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
    transition: transform 0.3s cubic-bezier(0.4, 1.3, 0.5, 1);
  }
  .switch input:checked + .track { background: #e0a64e; }
  .switch input:checked + .track::before { transform: translateX(20px); }
  .date-picker #datePickerToday { width: 100%; background: rgba(255,255,255,0.08); color: #c7c7cc; }
  .date-picker #datePickerToday:hover { background: rgba(255,255,255,0.16); }
  .eyebrow {
    font-family: 'Space Grotesk', sans-serif; font-size: 0.75rem; letter-spacing: 0.34em;
    text-transform: uppercase; color: #86868b; margin-bottom: 0.6rem; font-weight: 500;
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
  .daily-poem {
    color: #7d7d82; font-size: 0.85rem; margin-top: 0.6rem; font-style: italic;
    letter-spacing: 0.01em; opacity: 0; transition: opacity 0.4s ease;
  }
  .daily-poem.show { opacity: 1; }
  .daily-poem .poem-source { color: #5a5a5e; font-style: normal; margin-left: 0.4rem; }
  /* text-shadow 会从 .daily-poem 继承下来，这里只用补一下浅色模式下的字色，对比度才够 */
  body.sun-on .daily-poem .poem-source { color: #44444a; }
  .year-block { max-width: 1100px; margin: 0 auto 3.4rem; padding: 0 1.6rem; }
  .year-title {
    font-size: 1.3rem; font-weight: 600; color: #f5f5f7; margin-bottom: 1.1rem;
    display: flex; align-items: baseline; gap: 0.55rem; letter-spacing: -0.01em;
  }
  .year-title .count { color: #6e6e73; font-size: 0.78rem; font-weight: 400; font-family: 'Space Grotesk', sans-serif; }
  /* 首次加载/缓存没命中时 /api/memories 可能要等几秒（库跨年头多，R2 扫描+读 EXIF 需要时间），
     这段时间页面之前是纯空白，看起来像卡死了——之前摆的是跟正文毫不相干的灰色骨架块，
     现在直接复用 .cell/.frame-inner 这套"墙上挂照片"的视觉语言（图钉+米白卡纸+悬挂摇摆+
     未加载时的暖色转圈），骨架屏就是一排还没冲洗出来的照片，跟正文是同一套语言，不再是临时拼凑的占位符 */
  .skeleton-grid { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 22px 18px; padding: 1.5rem 1.6rem; max-width: 1100px; margin: 0 auto; }
  .skeleton-grid .cell { cursor: default; }
  @media (max-width: 640px) {
    .skeleton-grid { gap: 14px 10px; padding: 0.5rem 0.5rem 1.5rem; }
  }
  #content { transition: opacity 0.22s ease; }
  .grid {
    display: flex; flex-wrap: wrap; align-items: flex-start;
    gap: 22px 18px; padding: 0.5rem 0.5rem 1.5rem;
    perspective: 900px;
  }
  .cell {
    --tilt-deg: 0;
    position: relative; display: block; opacity: 0;
    cursor: pointer; background: #f5f5f0; border-radius: 3px;
    padding: 16px 10px 26px; box-shadow: 0 8px 20px rgba(0,0,0,0.5);
    transform-origin: top center;
    transform: rotate(calc(var(--tilt-deg) * 1deg));
    /* 两个动画分别管不同属性：cellFadeIn 只管淡入（带各自的入场延迟），hangSway 管晃动，互不打架 */
    animation: cellFadeIn 0.55s ease var(--enter-delay, 0s) forwards,
               hangSway var(--sway-dur, 5s) ease-in-out var(--sway-delay, 0s) infinite;
    transition: box-shadow 0.22s ease, z-index 0s;
  }
  @keyframes cellFadeIn { to { opacity: 1; } }
  /* will-change/preserve-3d 只在指尖联动 3D 倾斜真的在跑的时候才加（.touching 这个状态）——
     之前是每张照片永久挂着这两个属性，等于给每个格子都开一个独立 GPU 合成层常驻不撒手，
     一页几十到上百张照片，层一多整页滚动/交互都会变卡，这才是"都卡"的真正原因 */
  .cell.touching { transform-style: preserve-3d; will-change: transform; }
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
  /* 滚出视野的照片把晃动 + 加载圈动画都暂停掉，照片一多，几十个元素同时跑动画会让整页变卡 */
  .cell.offscreen { animation-play-state: paused; }
  .cell.offscreen .frame-inner::after { animation-play-state: paused; }
  @keyframes hangSway {
    0%   { transform: rotate(calc(var(--tilt-deg) * 1deg - 4deg)) translateX(-3px); }
    50%  { transform: rotate(calc(var(--tilt-deg) * 1deg + 4deg)) translateX(3px); }
    100% { transform: rotate(calc(var(--tilt-deg) * 1deg - 4deg)) translateX(-3px); }
  }
  /* 不再强制裁成正方形——加载完之前用 1:1 占位（跟加载圈对齐），加载完去掉占位比例，
     交给 img/video 的 height:auto 撑出真实比例，横图变宽矮、竖图变高窄 */
  .cell .frame-inner { position: relative; width: 100%; aspect-ratio: 1; overflow: hidden; border-radius: 1px; background: #1c1c1e; }
  .cell .frame-inner:has(.loaded) { aspect-ratio: auto; }
  /* 彻底解不出来、放弃兜底的（give-up，见 heicFallback）没有真图片可以撑比例——
     强制改回方形占位，不然一张没有任何尺寸的裂图会让整个格子塌成一条薄片 */
  .cell .frame-inner:has(.give-up) { aspect-ratio: 1; }
  .cell img, .cell video {
    display: block; width: 100%; height: auto;
    opacity: 0; transition: opacity 0.4s ease;
  }
  .cell img.loaded, .cell video.loaded { opacity: 1; }
  /* 图片还没加载出来时转一个小圈，加载完（img/video 拿到 loaded class）就淡出消失；
     用跟图钉同色的暖色，在深色背景下才看得清楚 */
  .cell .frame-inner::after {
    content: ''; position: absolute; top: 50%; left: 50%; width: 26px; height: 26px;
    margin: -13px 0 0 -13px; border-radius: 50%;
    border: 3px solid rgba(255,143,126,0.25); border-top-color: #ff8f7e;
    animation: spin 0.8s linear infinite;
    opacity: 1; transition: opacity 0.25s ease;
  }
  .cell .frame-inner:has(.loaded)::after { opacity: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .cell .frame-year {
    position: absolute; left: 0; right: 0; bottom: 6px; text-align: center;
    color: #8a8a82; font-size: 0.62rem; letter-spacing: 0.12em; font-family: 'Space Grotesk', sans-serif;
  }
  .play-badge {
    position: absolute; right: 16px; bottom: 28px; color: #fff;
    font-size: 0.78rem; text-shadow: 0 1px 3px rgba(0,0,0,0.6);
    transition: opacity 0.2s ease; pointer-events: none;
  }
  /* 鼠标移上去自动播放预览时，"▶ 视频"提示先淡出，别挡着画面 */
  .cell:hover .play-badge { opacity: 0; }
  .live-photo-cell { position: relative; }
  .cell-live-video {
    position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
    opacity: 0; transition: opacity 0.2s ease;
  }
  .live-photo-cell.playing .cell-live-video { opacity: 1; }
  .live-photo-cell.playing img { opacity: 0; }
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
    /* pinch-zoom：挡住单指拖动（不让背后整页跟着滑切手势一起动），但留着双指缩放——
       移动端看照片细节很常用得上，用 touch-action: none 会连这个一起挡掉 */
    touch-action: pinch-zoom;
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
  .lightbox-stage::after {
    content: ''; position: absolute; top: 50%; left: 50%; width: 32px; height: 32px;
    margin: -16px 0 0 -16px; border-radius: 50%;
    border: 3px solid rgba(255,255,255,0.18); border-top-color: rgba(255,255,255,0.7);
    animation: spin 0.8s linear infinite;
    opacity: 1; transition: opacity 0.25s ease;
  }
  .lightbox-stage:has(.show)::after { opacity: 0; }
  .live-photo-wrap { position: relative; display: inline-block; cursor: pointer; }
  .live-photo-video {
    position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
    border-radius: 10px; opacity: 0; pointer-events: none;
  }
  .live-photo-wrap.playing .live-photo-video { opacity: 1; }
  .live-photo-wrap.playing img { opacity: 0; }
  .live-photo-badge {
    position: absolute; top: 0.8rem; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 0.4rem; color: #fff; font-size: 0.78rem;
    letter-spacing: 0.03em; text-shadow: 0 1px 3px rgba(0,0,0,0.6); pointer-events: none;
    opacity: 0; transition: opacity 0.3s ease;
  }
  .live-photo-wrap:hover .live-photo-badge, .live-photo-wrap.playing .live-photo-badge { opacity: 1; }
  .live-photo-icon {
    width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid #fff;
    border-top-color: transparent; box-sizing: border-box;
  }
  .live-photo-wrap.playing .live-photo-icon { animation: spin 1.2s linear infinite; }
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
  .back-to-top {
    position: fixed; bottom: 2rem; right: 1.6rem; z-index: 40;
    width: 42px; height: 42px; border-radius: 50%; border: none;
    background: rgba(255,255,255,0.1); backdrop-filter: blur(10px);
    color: #c7c7cc; cursor: pointer; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
    opacity: 0; transform: translateY(12px); pointer-events: none;
    transition: opacity 0.25s ease, transform 0.25s ease, background 0.15s ease, color 0.15s ease;
  }
  .back-to-top.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
  .back-to-top:hover { background: rgba(255,255,255,0.18); color: #f5f5f7; }
  .back-to-top svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  body.sun-on .back-to-top { background: rgba(255,255,255,0.65); color: #3a3a3c; box-shadow: 0 4px 14px rgba(0,0,0,0.15); }
  body.sun-on .back-to-top:hover { background: rgba(255,255,255,0.85); color: #1c1c1e; }
  @media (max-width: 640px) {
    .back-to-top { bottom: 1.2rem; right: 1rem; width: 38px; height: 38px; }
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .lightbox-caption {
    position: absolute; left: 50%; bottom: -2.2rem; transform: translateX(-50%);
    color: #8fa1b8; font-size: 0.8rem; white-space: nowrap;
  }
  .lightbox-ai-caption {
    position: absolute; left: 50%; bottom: -3.6rem; transform: translateX(-50%);
    color: #c9d4e0; font-size: 0.82rem; font-style: italic; text-align: center;
    max-width: 80vw; line-height: 1.4;
  }
  body.sun-on .lightbox-ai-caption { color: #3a3a3c; text-shadow: 0 1px 8px rgba(255,255,255,0.5); }
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
  /* 自定义鼠标指针：一个相机对焦取景框的样子，呼应"照片回忆"的主题——
     四个角括号 + 中心一个暖色光点，悬停在可点击元素上时角括号收紧、中心点变亮，
     像相机锁定焦点的反馈，比普通箭头更有意思 */
  #cursorDot, #cursorDot * {
    pointer-events: none !important;
  }
  #cursorDot {
    position: fixed; top: 0; left: 0; width: 30px; height: 30px; margin: -15px 0 0 -15px;
    z-index: 70; opacity: 0;
    transition: opacity 0.25s ease, transform 0.2s cubic-bezier(0.2, 0.8, 0.3, 1.3);
  }
  #cursorDot .br {
    position: absolute; width: 9px; height: 9px;
    border: 1.5px solid rgba(255, 200, 140, 0.85);
    filter: drop-shadow(0 0 3px rgba(255, 180, 90, 0.5));
    transition: width 0.2s ease, height 0.2s ease, border-color 0.2s ease;
  }
  #cursorDot .br.tl { top: 0; left: 0; border-right: none; border-bottom: none; }
  #cursorDot .br.tr { top: 0; right: 0; border-left: none; border-bottom: none; }
  #cursorDot .br.bl { bottom: 0; left: 0; border-right: none; border-top: none; }
  #cursorDot .br.brc { bottom: 0; right: 0; border-left: none; border-top: none; }
  #cursorDot .center-dot {
    position: absolute; top: 50%; left: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px;
    border-radius: 50%; background: #ffd9a0; box-shadow: 0 0 6px rgba(255, 200, 120, 0.85);
    transition: width 0.2s ease, height 0.2s ease, margin 0.2s ease;
  }
  #cursorDot.hover { transform: scale(0.72); }
  #cursorDot.hover .br { border-color: #ffd9a0; filter: drop-shadow(0 0 5px rgba(255, 200, 120, 0.8)); }
  #cursorDot.hover .center-dot { width: 6px; height: 6px; margin: -3px 0 0 -3px; }
  @media (pointer: fine) {
    body.custom-cursor-active, body.custom-cursor-active * { cursor: none !important; }
  }

  @media (pointer: coarse) {
    /* 触屏设备禁用摇摆动画，只保留淡入；用户滚动时卡片不乱晃 */
    .cell { animation: cellFadeIn 0.55s ease var(--enter-delay, 0s) forwards !important; }
  }
  @media (max-width: 640px) {
    #fingertip, #cursorDot { display: none !important; }
    body { padding: 0 0 3rem; }
    header { padding: 3.2rem 1rem 2.2rem; }
    .subtitle { font-size: 0.85rem; }
    .year-block { padding: 0 1rem; }
    /* 移动端两列：50% 减掉一半列间距，两张卡片加一个 10px gap 正好撑满容器，
       避免用 40vw 时因为父元素有 padding 导致右侧留白、缩放后看起来不居中 */
    .grid { gap: 14px 10px; justify-content: center; }
    .cell { width: calc(50% - 5px) !important; height: auto !important; }
    .lightbox { padding: 0.8rem; }
    .lightbox-stage img, .lightbox-stage video { max-width: 96vw; max-height: 78vh; }
    .lightbox-nav { font-size: 1.8rem; padding: 0.6rem; }
    .lightbox-nav.prev { left: 0.2rem; }
    .lightbox-nav.next { right: 0.2rem; }
    /* 顶部这几个悬浮控件之前固定用 rem 定位，刘海屏/灵动岛挡一截或者贴边太近，
       用 max() 跟安全区比大小，没有安全区的设备上跟原来的 rem 值一样，不受影响 */
    .lightbox-actions { top: max(0.6rem, env(safe-area-inset-top)); right: max(0.8rem, env(safe-area-inset-right)); }
    .lightbox-btn { width: 36px; height: 36px; }
    .lightbox-caption { bottom: -1.8rem; font-size: 0.72rem; }
    .lightbox-ai-caption { bottom: -3rem; font-size: 0.72rem; max-width: 90vw; }
    .header-controls { top: max(0.9rem, env(safe-area-inset-top)); right: max(0.8rem, env(safe-area-inset-right)); gap: 0.6rem; }
    .date-toggle, .sunlight-switch .switch { transform: scale(1.05); }
    .sunlight-switch span { display: none; }
    .play-memories { top: max(0.9rem, env(safe-area-inset-top)); left: max(0.8rem, env(safe-area-inset-left)); width: 34px; height: 34px; }
    .date-picker { top: 3.4rem; right: 0.8rem; left: 0.8rem; width: auto; }
    .back-to-top { bottom: max(1.2rem, env(safe-area-inset-bottom)); right: max(1rem, env(safe-area-inset-right)); }
    .cell, .date-toggle, .play-memories, .play-memories button, .lightbox-btn, .lightbox-nav, .sunlight-switch .track {
      -webkit-tap-highlight-color: transparent;
    }
  }
`;
const APP_JS = `
  // 拼 HTML 字符串时用来转义属性值，避免文件名/路径里万一带了引号之类的字符把属性或内嵌脚本弄断
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

  // 缩略图第一次加载失败，先按 5s/15s/45s 退避重试原来的 /thumb/ 链接几次（破一下缓存强制重新请求）——
  // 很多裂图只是服务端转码/边缘缓存这会儿还没跟上，过一会儿自己就好了，不用等用户手动刷新整页。
  // 重试次数用完还是不行，才真正走 heicFallback 的现场解码/原图兜底
  const IMAGE_RETRY_DELAYS = [5000, 15000, 45000];
  window.scheduleImageRetry = function (imgEl, thumbSrc, originalUrl, attempt) {
    attempt = attempt || 0;
    if (attempt >= IMAGE_RETRY_DELAYS.length) {
      heicFallback(imgEl, originalUrl);
      return;
    }
    setTimeout(() => {
      if (!document.body.contains(imgEl)) return; // 这张图已经不在页面上了（比如切了日期），别再瞎重试
      imgEl.onerror = () => scheduleImageRetry(imgEl, thumbSrc, originalUrl, attempt + 1);
      imgEl.src = thumbSrc + (thumbSrc.indexOf('?') >= 0 ? '&' : '?') + '_retry=' + Date.now();
    }, IMAGE_RETRY_DELAYS[attempt]);
  };

  // 缩放失败时的兜底：非 HEIC 文件直接换成原图（浏览器本来就能显示），
  // 只有 HEIC 才需要在浏览器里用 heic2any 现场解码，不依赖任何服务端转码。
  // 注意：'loaded' 必须等新图真的加载完才能加，不能加完 src 就立刻标记完成——
  // 不然图片数据还没到，opacity 先变成 1，看到的就是浏览器原生的"裂图"占位图标
  // heic2any 偶尔会因为浏览器一时半会的内存/资源紧张失败（不是文件真解不开），重试几次再放弃；
  // 重试间隔故意拉开（1.5s/4s），别让标签页在很短时间里反复占满内存做无意义的重试
  const HEIC_DECODE_RETRY_DELAYS = [1500, 4000];
  window.heicFallback = async function (imgEl, originalUrl, attempt) {
    attempt = attempt || 0;
    if (!/\.heic$/i.test(originalUrl)) {
      imgEl.onload = () => imgEl.classList.add('loaded');
      imgEl.src = originalUrl;
      return;
    }
    try {
      const resp = await fetch(originalUrl);
      const blob = await resp.blob();
      const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.85 });
      const previewBlob = Array.isArray(converted) ? converted[0] : converted;
      const objUrl = URL.createObjectURL(previewBlob);
      imgEl.onload = () => imgEl.classList.add('loaded');
      imgEl.src = objUrl;
      // 顺手把现场解码的结果回传存进 PREVIEWS 桶，下次别的访问者就不用再解码一遍了——
      // 哪怕服务端那边重试次数早就用完放弃了，这次浏览器端解码成功一样会被接受存进去
      const heicKey = originalUrl.replace('/img/', '');
      fetch('/api/upload-heic-preview?key=' + heicKey, { method: 'POST', body: previewBlob }).catch(() => {});
    } catch {
      if (attempt < HEIC_DECODE_RETRY_DELAYS.length) {
        setTimeout(() => {
          if (document.body.contains(imgEl)) heicFallback(imgEl, originalUrl, attempt + 1);
        }, HEIC_DECODE_RETRY_DELAYS[attempt]);
        return;
      }
      // 重试次数用完还是解不出来，才真正放弃，至少别让它一直卡在 opacity:0 看起来像黑框；
      // 多加个 give-up 标记——没有真图片撑不出原图比例，靠这个让方形占位比例继续生效，
      // 不然 frame-inner 会被 :has(.loaded) 那条规则放行成 auto，没尺寸的裂图直接塌成一条薄片
      imgEl.classList.add('loaded', 'give-up');
    }
  };

  window.livePhotoTouchStart = function(el, e) {
    if (e.touches.length > 1) return; // ignore pinch
    el._lpTimer = setTimeout(() => {
      el._lpPlaying = true;
      el.classList.add('playing');
      const v = el.querySelector('video');
      v.currentTime = 0;
      v.play().catch(() => {});
      if (navigator.vibrate) navigator.vibrate(10);
    }, 350);
  };
  window.livePhotoTouchEnd = function(el, e) {
    clearTimeout(el._lpTimer);
    if (el._lpPlaying) {
      el._lpPlaying = false;
      el.classList.remove('playing');
      el.querySelector('video').pause();
      e.preventDefault(); // suppress click→lightbox after long-press
    }
  };

  // 今日诗词：跟翻看哪个历史日期无关，配的是"今天"这句——挂个第三方接口失败/204 都不影响主功能
  fetch('/api/poem').then(r => r.status === 204 ? null : r.json()).then(poem => {
    if (!poem) return;
    const el = document.getElementById('dailyPoem');
    // 用 textContent/DOM API 拼，不用 innerHTML——内容来自第三方接口，不放心直接当 HTML 插进去
    el.textContent = '「' + poem.content + '」';
    const source = document.createElement('span');
    source.className = 'poem-source';
    source.textContent = '—— ' + poem.dynasty + '·' + poem.author + '《' + poem.title + '》';
    el.appendChild(source);
    el.classList.add('show');
  }).catch(() => {});

  const params = new URLSearchParams(location.search);
  const now = new Date();
  // 改成 let——切日期不再整页刷新，这两个变量要跟着原地更新（地图链接、日历高亮都靠它们）
  let month = params.get('month') || String(now.getMonth() + 1).padStart(2, '0');
  let day = params.get('day') || String(now.getDate()).padStart(2, '0');

  // 地图图标带上当前正在看的日期，这样从某个历史日期点进地图，看到的也是那一天的照片
  document.getElementById('mapLink').href = '/map?month=' + month + '&day=' + day;

  // 自制日历：点小日历图标展开，选好日期跳转到 ?month=&day=
  // 不用原生 <input type="date">，因为浏览器自带的日历弹层样式没法跟这套深色 UI 统一
  const dateToggle = document.getElementById('dateToggle');
  const datePicker = document.getElementById('datePicker');
  const calMonthLabel = document.getElementById('calMonthLabel');
  const calGrid = document.getElementById('calGrid');
  const calPrevMonth = document.getElementById('calPrevMonth');
  const calNextMonth = document.getElementById('calNextMonth');

  let calViewYear = now.getFullYear();
  let calViewMonth = Number(month) - 1; // 0-based
  let currentMonth = Number(month);
  let currentDay = Number(day);

  function renderCalendar() {
    calMonthLabel.textContent = calViewYear + '年' + String(calViewMonth + 1).padStart(2, '0') + '月';
    const firstWeekday = (new Date(calViewYear, calViewMonth, 1).getDay() + 6) % 7; // 周一为第一列
    const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    const isCurrentRealMonth = calViewYear === now.getFullYear() && calViewMonth === now.getMonth();
    const isViewingSelectedMonth = calViewMonth + 1 === currentMonth;

    let html = '';
    for (let i = 0; i < firstWeekday; i++) html += '<button disabled></button>';
    for (let d = 1; d <= daysInMonth; d++) {
      const classes = [];
      if (isCurrentRealMonth && d === now.getDate()) classes.push('today');
      if (isViewingSelectedMonth && d === currentDay) classes.push('selected');
      html += '<button class="' + classes.join(' ') + '" data-day="' + d + '">' + d + '</button>';
    }
    calGrid.innerHTML = html;
    // 点哪天就直接加载，不用再多点一次"查看"——少一步，也不会让人觉得"点了没反应"。
    // 原来这里是 location.href 整页刷新，切一次日期等于把页面所有初始化（自定义指针、指尖联动、
    // 环境音、IntersectionObserver……）全部重新跑一遍，体感上的"卡顿"很大一部分就是这个整页刷新本身，
    // 不是渲染逻辑慢。改成 history.pushState + 原地重新拉数据，URL 照样会变、能收藏/分享，但不刷新整页
    calGrid.querySelectorAll('button[data-day]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const m = String(calViewMonth + 1).padStart(2, '0');
        const d = String(btn.dataset.day).padStart(2, '0');
        navigateToDate(m, d);
        datePicker.classList.remove('open');
      };
    });
  }
  renderCalendar();

  // 切日期统一走这个函数：更新 URL（pushState，不刷新整页）、地图链接、日历高亮状态，再原地重新加载数据
  function navigateToDate(m, d) {
    month = m; day = d;
    currentMonth = Number(m); currentDay = Number(d);
    history.pushState(null, '', location.pathname + '?month=' + m + '&day=' + d);
    document.getElementById('mapLink').href = '/map?month=' + m + '&day=' + d;
    renderCalendar();
    loadMemories(m, d);
  }
  // 浏览器前进/后退也要认这个 URL，不然退回去地址栏变了但页面内容没跟着变
  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search);
    const nowD = new Date();
    month = p.get('month') || String(nowD.getMonth() + 1).padStart(2, '0');
    day = p.get('day') || String(nowD.getDate()).padStart(2, '0');
    currentMonth = Number(month); currentDay = Number(day);
    document.getElementById('mapLink').href = '/map?month=' + month + '&day=' + day;
    renderCalendar();
    loadMemories(month, day);
  });

  calPrevMonth.onclick = (e) => {
    e.stopPropagation();
    calViewMonth -= 1;
    if (calViewMonth < 0) { calViewMonth = 11; calViewYear -= 1; }
    renderCalendar();
  };
  calNextMonth.onclick = (e) => {
    e.stopPropagation();
    calViewMonth += 1;
    if (calViewMonth > 11) { calViewMonth = 0; calViewYear += 1; }
    renderCalendar();
  };

  dateToggle.onclick = (e) => {
    e.stopPropagation();
    datePicker.classList.toggle('open');
  };

  // "跳到某一年"下拉菜单
  const yearToggle = document.getElementById('yearToggle');
  const yearMenu = document.getElementById('yearMenu');
  yearToggle.onclick = (e) => {
    e.stopPropagation();
    yearMenu.classList.toggle('open');
  };

  document.addEventListener('click', (e) => {
    if (datePicker.classList.contains('open') && !datePicker.contains(e.target) && e.target !== dateToggle && !dateToggle.contains(e.target)) {
      datePicker.classList.remove('open');
    }
    if (yearMenu.classList.contains('open') && !yearMenu.contains(e.target) && e.target !== yearToggle && !yearToggle.contains(e.target)) {
      yearMenu.classList.remove('open');
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
  const lightboxAiCaption = document.getElementById('lightboxAiCaption');
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

  // 回到顶部：滚得够远才出现，避免一开始就挡在右下角
  const backToTop = document.getElementById('backToTop');
  window.addEventListener('scroll', () => {
    backToTop.classList.toggle('show', window.scrollY > window.innerHeight * 0.6);
  }, { passive: true });
  backToTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

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
    lightboxCaption.textContent = p.year + ' 年' + (p.place ? ' · ' + p.place : '');
    lightboxAiCaption.textContent = p.caption || '';
    lightboxAiCaption.style.display = p.caption ? '' : 'none';
    lightboxDownload.href = p.url + '?dl=1';
    lightboxDownload.download = p.key.split('/').pop();
    lightboxShare.dataset.url = location.origin + p.url;
    lightboxShare.dataset.year = p.year;

    lightboxBody.innerHTML = '';
    // "show" 这个淡入 class 必须等图片/视频真的有数据了才加，不能用固定延时——
    // 不然图片还没下载完就先淡入，看到的就是浏览器原生的"裂图"占位图标，等真实画面到了才覆盖上去
    const showWhenReady = (target) => requestAnimationFrame(() => requestAnimationFrame(() => target.classList.add('show')));

    if (p.type === 'video') {
      const el = document.createElement('video');
      el.className = pickEffect();
      el.src = p.url;
      el.controls = !autoPlaying;
      el.muted = autoPlaying;
      el.autoplay = true;
      el.onended = () => { if (autoPlaying) nextSlide(); };
      el.onloadeddata = () => showWhenReady(el);
      lightboxBody.appendChild(el);
    } else if (p.type === 'live') {
      // Live Photo：默认是静态图，鼠标悬浮（桌面）/ 按住（移动端）才播放配对的短视频预览，松开恢复静态图
      const img = document.createElement('img');
      img.className = pickEffect();
      img.decoding = 'async';
      img.onload = () => showWhenReady(img);
      img.onerror = () => { img.onerror = null; heicFallback(img, p.url); };
      img.src = p.url.replace('/img/', '/thumb/') + '?w=1600&q=85&fit=scale-down';

      const video = document.createElement('video');
      video.className = 'live-photo-video';
      video.src = p.videoUrl;
      // 不静音——播放是悬浮/长按这个用户主动触发的手势带起来的，浏览器不会拦自动播放限制
      video.loop = true;
      video.preload = 'metadata';

      const badge = document.createElement('div');
      badge.className = 'live-photo-badge';
      badge.innerHTML = 'Live Photo<span class="live-photo-icon"></span>';

      const wrap = document.createElement('div');
      wrap.className = 'live-photo-wrap';
      wrap.appendChild(img);
      wrap.appendChild(video);
      wrap.appendChild(badge);
      lightboxBody.appendChild(wrap);

      const playPreview = () => { video.currentTime = 0; video.play().catch(() => {}); wrap.classList.add('playing'); };
      const stopPreview = () => { video.pause(); wrap.classList.remove('playing'); };
      wrap.addEventListener('mouseenter', playPreview);
      wrap.addEventListener('mouseleave', stopPreview);
      wrap.addEventListener('touchstart', (e) => { e.preventDefault(); playPreview(); }, { passive: false });
      wrap.addEventListener('touchend', stopPreview);
    } else {
      // 全屏看大图也不用原图，按屏幕尺寸缩放一版；转换失败（额度超了/HEIC 解不出来）就在浏览器里现场解码兜底
      const el = document.createElement('img');
      el.className = pickEffect();
      el.decoding = 'async';
      el.onload = () => showWhenReady(el);
      el.onerror = () => { el.onerror = null; heicFallback(el, p.url); };
      el.src = p.url.replace('/img/', '/thumb/') + '?w=1600&q=85&fit=scale-down';
      lightboxBody.appendChild(el);
    }

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
    // 灯箱内左右滑动切图时，背后的整页也会被浏览器当成"想滚动页面"一起带着动——
    // 锁住 body 滚动，关闭时再还原
    document.body.style.overflow = 'hidden';
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
    document.body.style.overflow = '';
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
  const cursorDot = document.getElementById('cursorDot');
  const CURSOR_HOVER_SELECTOR = 'a, button, .cell, input, label, [onclick]';

  document.addEventListener('mousemove', (e) => {
    pointerX = e.clientX; pointerY = e.clientY; pointerActive = true;
    document.body.classList.add('custom-cursor-active');
    if (cursorDot) {
      cursorDot.style.opacity = '1';
      cursorDot.style.left = pointerX + 'px';
      cursorDot.style.top = pointerY + 'px';
      cursorDot.classList.toggle('hover', !!e.target.closest(CURSOR_HOVER_SELECTOR));
    }
  });
  document.addEventListener('mouseleave', () => {
    pointerActive = false;
    if (cursorDot) cursorDot.style.opacity = '0';
    // 鼠标离开页面时一次性清掉所有"指尖联动"的倾斜状态，不用等 wallTick 下一帧再清
    for (const cell of visibleCells) {
      cell.classList.remove('touching');
      cell.style.transform = '';
    }
  });

  // 只对视口附近（含一点缓冲）的照片做指尖联动计算，照片墙很长时也不用每帧遍历全部 cell
  const visibleCells = new Set();
  const frameInnerCache = new WeakMap(); // 缓存 .frame-inner 引用，不用每次重新 querySelector

  // 缓存每张可见照片的中心点坐标——这才是"鼠标一动就卡"的真正原因：
  // 原来 wallTick 每帧（鼠标在动的时候）都对所有可见照片强制触发一次布局重排去算位置，
  // 现在只在滚动/缩放窗口时才重新算一遍，鼠标移动本身不再触发任何布局读取
  const cellCenters = new Map();
  function refreshCellCenters() {
    for (const cell of visibleCells) {
      const inner = frameInnerCache.get(cell) || cell;
      const rect = inner.getBoundingClientRect();
      cellCenters.set(cell, { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, w: rect.width, h: rect.height });
    }
  }
  let refreshQueued = false;
  function queueRefreshCellCenters() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshCellCenters(); refreshQueued = false; });
  }
  window.addEventListener('scroll', queueRefreshCellCenters, { passive: true });
  window.addEventListener('resize', queueRefreshCellCenters, { passive: true });

  const cellObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visibleCells.add(entry.target);
        entry.target.classList.remove('offscreen');
        // IntersectionObserver 自己就算好了 boundingClientRect，直接拿来用，不用再查一次
        const r = entry.boundingClientRect;
        frameInnerCache.set(entry.target, entry.target.querySelector('.frame-inner') || entry.target);
        cellCenters.set(entry.target, { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height });
      } else {
        visibleCells.delete(entry.target);
        cellCenters.delete(entry.target);
        entry.target.classList.remove('touching');
        entry.target.style.transform = '';
        // 滚出视野的照片把晃动/加载圈动画暂停掉，照片多的时候一堆元素同时跑动画会让页面变卡
        entry.target.classList.add('offscreen');
      }
    }
  }, { rootMargin: '200px' });

  // 独立视频 cell 用 data-src 占位，进视口附近才真正赋值触发加载——<video> 标签本身不支持
  // loading="lazy"，不接这个的话一进页面所有视频会同时发起 Range 请求抢带宽，体感卡顿
  const videoLazyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const v = entry.target;
      v.src = v.dataset.src;
      v.removeAttribute('data-src');
      videoLazyObserver.unobserve(v);
    }
  }, { rootMargin: '300px' });

  function wallTick() {
    requestAnimationFrame(wallTick);

    // 指尖光点用 lerp 缓冲跟随，制造轻微的"跟手"延迟感
    fingerX += (pointerX - fingerX) * 0.18;
    fingerY += (pointerY - fingerY) * 0.18;
    if (fingertip) {
      fingertip.style.opacity = pointerActive ? '1' : '0';
      fingertip.style.transform = 'translate(' + fingerX + 'px,' + fingerY + 'px) translate(-50%,-50%)';
    }

    // 鼠标没在页面上动的时候，没必要每帧都去算每张照片的距离；
    // 鼠标离开时已经在 mouseleave 里把 touching 状态一次性清过了
    if (!pointerActive) return;

    for (const cell of visibleCells) {
      const center = cellCenters.get(cell);
      if (!center) continue; // 用缓存的坐标，不在这里触发任何布局读取
      const dx = pointerX - center.cx, dy = pointerY - center.cy;
      const dist = Math.hypot(dx, dy);

      if (dist < RIPPLE_RADIUS) {
        const factor = 1 - dist / RIPPLE_RADIUS; // 0~1，越近越强
        const px = dx / center.w, py = dy / center.h;
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

  // 每次调用递增，旧请求返回时 seq 已变则丢弃，防止快速切换日期时旧数据覆盖新内容
  let _memSeq = 0;
  // 首次加载时骨架屏已摆好，等数据到了再淡出骨架→淡入真实内容；后续切换则立即淡出旧内容
  let _memFirstLoad = true;

  // 切日期时（navigateToDate/popstate）会用新的 month/day 再调一次这个函数，原地刷新内容，
  // 不会触发整页 location.href 跳转——声明成 function 而不是 const，靠 hoisting 保证在它定义之前
  // 出现的 navigateToDate/popstate 里提前引用到它也没问题
  function loadMemories(month, day) {
    const content = document.getElementById('content');
    const subtitle = document.getElementById('subtitle');
    const FADE_MS = 220; // 跟 #content 的 CSS transition 时长对齐，不然淡出动画没走完就被打断，看起来像卡顿
    const seq = ++_memSeq;
    const isFirst = _memFirstLoad;
    _memFirstLoad = false;

    // 骨架屏的卡片直接复用真实照片用的 .cell/.frame-inner——尺寸/倾斜角/摇摆节奏的算法
    // 也跟下面渲染真实照片时的 pickSize/pickTilt 保持一致（seed 就用数组下标），
    // 这样骨架屏看起来就是同一套"墙上挂照片"，而不是另一套临时拼凑的占位符
    const SKELETON_SIZES = [150, 190, 230, 170, 210];
    const SKELETON_TILTS = [-3, -1.5, 0, 1.5, 3];
    const SKELETON_HTML = '<div class="skeleton-grid">' + SKELETON_SIZES.map((w, i) => {
      const swayDur = (4 + (i % 4) * 0.7).toFixed(1);
      const swayDelay = ((i % 5) * 0.5).toFixed(1);
      const enterDelay = (i * 0.05).toFixed(2);
      const style = 'width:' + w + 'px;--tilt-deg:' + SKELETON_TILTS[i] + ';--sway-dur:' + swayDur + 's;--sway-delay:' + swayDelay + 's;--enter-delay:' + enterDelay + 's;';
      return '<div class="cell" style="' + style + '"><div class="frame-inner"></div></div>';
    }).join('') + '</div>';

    function fadeOut() {
      content.style.opacity = '0';
      return new Promise((resolve) => setTimeout(resolve, FADE_MS));
    }
    function fadeIn() {
      requestAnimationFrame(() => requestAnimationFrame(() => { content.style.opacity = '1'; }));
    }

    // showedSkeleton 记的是骨架屏有没有真的画出来过；fetchSettled 记数据是不是已经落定（成功或失败都算）。
    // 网络够快时，220ms 的退场动画还没跑完数据就已经到了——这时候没必要再画一遍骨架屏自己又淡入，
    // 不然真实内容马上又要把它淡出换掉，平白多一轮闪烁；骨架屏那边的淡入还用的是双 rAF（下一帧才生效），
    // 跟真实内容几乎同时触发的淡入抢着改 opacity，谁后跑谁赢，体感就是"数据明明到了却还卡一下骨架屏"
    let showedSkeleton = false;
    let fetchSettled = false;

    // 切日期：旧内容先淡出，再换成骨架屏淡入——中间不再是一片空白（衬着纯黑背景看起来像黑屏/卡死），
    // 骨架屏的脉冲动画能让用户看出"正在加载"。首次加载本来就是骨架屏直出，不用走这一步
    let skeletonReady = Promise.resolve();
    if (!isFirst) {
      subtitle.textContent = '正在唤醒回忆…';
      playBtn.disabled = true;
      yearToggle.disabled = true;
      visibleCells.clear();
      cellCenters.clear();
      allPhotos = [];
      skeletonReady = fadeOut().then(() => {
        if (seq !== _memSeq) return;
        if (!fetchSettled) {
          showedSkeleton = true;
          content.innerHTML = SKELETON_HTML;
          fadeIn();
        }
      });
    }

    const fetchPromise = fetch('/api/memories?month=' + month + '&day=' + day).then(r => {
      if (!r.ok) throw new Error('memories fetch failed: ' + r.status);
      return r.json();
    });
    // 独立的旁路 .then，只用来记"落没落定"，不影响 fetchPromise 本身往 Promise.all 传播的 resolve/reject
    fetchPromise.then(() => { fetchSettled = true; }, () => { fetchSettled = true; });

    Promise.all([skeletonReady, fetchPromise]).then(([, data]) => {
      if (seq !== _memSeq) return; // 用户已切换到别的日期，丢弃过期结果

      const apply = () => {
        document.getElementById('title').innerHTML = '<span class="date">' + data.month + '月' + data.day + '日</span>，那些年的此刻';

        if (!data.years.length) {
          subtitle.textContent = '这一天，还没有故事';
          content.innerHTML = '<div class="empty">去拍一张，留给未来的自己</div>';
          fadeIn();
          return;
        }

        const totalPhotos = data.years.reduce((s, y) => s + y.photos.length, 0);
        subtitle.textContent = '横跨 ' + data.years.length + ' 个年头，' + totalPhotos + ' 个瞬间';
        playBtn.disabled = false;

        // 切日期会把整面墙的照片换掉，旧的 cell 元素马上就从 DOM 里消失了——
        // 不清的话 visibleCells/cellCenters 里攒着的是已经被扔掉的旧元素引用，越点几次日期切换越积越多
        if (isFirst) {
          visibleCells.clear();
          cellCenters.clear();
          allPhotos = [];
        }
        data.years.forEach(y => y.photos.forEach(p => allPhotos.push({ ...p, year: y.year })));

        // 给每张图随机一个尺寸档位、轻微倾斜角度，再配一个随机的晃动周期和延迟，做出挂在墙上被风吹的参差感
        const SIZES = [150, 190, 230, 170, 210];
        function pickSize(seed) { return SIZES[seed % SIZES.length]; }
        function pickTilt(seed) { const angles = [-3, -1.5, 0, 1.5, 3]; return angles[seed % angles.length]; }

        // 一年的照片太多时，先精选一部分摆出来：视频/Live Photo 优先收录，然后是 AI 打过分的高分照片，
        // 剩下名额（包括还没被 AI 打分的）按时间均匀抽样，保证不是"挤在某一段"，而是有代表性的几个瞬间
        const FEATURED_LIMIT = 10;
        function pickFeatured(photos, limit) {
          if (photos.length <= limit) return null; // null 表示不需要折叠，全部都是精选
          const featured = new Set();
          photos.forEach((p, i) => { if ((p.type === 'video' || p.type === 'live') && featured.size < limit) featured.add(i); });

          // 带坐标 + 检测到人脸的"真实拍摄"照片最优先（screenshots/表情包之类的一般没有这两样），
          // 同样按 AI 分数从高到低排
          const realPhotoIdx = photos
            .map((p, i) => ({ i, score: p.score }))
            .filter(({ i, score }) => !featured.has(i) && typeof score === 'number' && photos[i].hasFace && photos[i].place)
            .sort((a, b) => b.score - a.score);
          for (const { i } of realPhotoIdx) {
            if (featured.size >= limit) break;
            featured.add(i);
          }

          // 剩下名额里，AI 打过分的非视频照片按分数从高到低收录
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

        // 移动端 CSS 把 .cell 强制按 calc(50% - 5px) 渲染（容器宽度的一半减半个列间距），
        // 折算成 px 约等于 0.48 * innerWidth（年份块左右各 1rem + 网格各 0.5rem padding），
        // 缩略图分辨率要是还按桌面那个 size 算，手机上经常对不上：要小了模糊，要大了白白浪费流量
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const isMobileLayout = window.innerWidth <= 640;
        const mobileRenderSize = window.innerWidth * 0.48;

        // 照片不是一次性全部弹出来，按页面上的出场顺序错开一点时间依次淡入；
        // 延迟封顶（0.9s），照片特别多的时候后面那些不用傻等，很快就一起跟上
        let globalCellIndex = 0;
        content.innerHTML = data.years.map(y => {
          const featured = pickFeatured(y.photos, FEATURED_LIMIT);
          const extraCount = featured ? y.photos.length - featured.size : 0;
          const cells = y.photos.map((p, pi) => {
            // allPhotos 是按完全相同的 年->照片 嵌套顺序铺出来的，flatIndex 直接用这个递增计数器就是它在
            // allPhotos 里的下标，不用每张照片都 findIndex 整个数组查一遍——照片一多，那是 O(n²) 的隐藏开销，
            // 切日期时一大批照片同时算就是页面卡顿的一部分
            const flatIndex = globalCellIndex;
            const size = pickSize(pi + y.year.charCodeAt(0));
            const tilt = pickTilt(pi);
            const swayDur = (4 + (pi % 4) * 0.7).toFixed(1);
            const swayDelay = ((pi % 5) * 0.5).toFixed(1);
            const enterDelay = Math.min(globalCellIndex * 0.05, 0.9).toFixed(2);
            globalCellIndex++;
            // 不再固定 height——照片按原图比例显示，宽度定了，高度交给 frame-inner 的 aspect-ratio 撑出来
            const style = \`width:\${size}px;--tilt-deg:\${tilt};--sway-dur:\${swayDur}s;--sway-delay:\${swayDelay}s;--enter-delay:\${enterDelay}s;\`;
            const extraClass = featured && !featured.has(pi) ? ' extra' : '';
            // 墙上的缩略图按实际显示尺寸 * 设备像素比要图（普通屏 1x 就不用多要 2x 的流量/解码开销，
            // 高分屏封顶在 2x，不然 3x 机型一次性吃满带宽）；转换失败（HEIC 等）就在 onerror 里走浏览器端解码兜底
            const thumbW = Math.round((isMobileLayout ? mobileRenderSize : size) * dpr);
            // 不再传 h= + fit=cover 强制裁成正方形——只限宽，fit=scale-down 按原图比例缩放，不裁内容
            const thumbSrc = p.url.replace('/img/', '/thumb/') + '?w=' + thumbW + '&q=75&fit=scale-down';
            if (p.type === 'video') {
              return \`<div class="cell\${extraClass}" style="\${style}" onclick="openLightbox(\${flatIndex}, false)"><div class="frame-inner"><video data-src="\${escAttr(p.url)}#t=0.5" muted loop preload="metadata" onloadeddata="this.classList.add('loaded')" onmouseenter="this.play().catch(()=>{})" onmouseleave="this.pause();this.currentTime=0.5"></video></div><span class="play-badge">▶ 视频</span><span class="frame-year">\${y.year}</span></div>\`;
            }
            if (p.type === 'live') {
              // Live Photo 缩略图：默认显示静态图，悬浮（桌面）/长按（移动端）才播放配对的短视频
              // 网格缩略图上不展示 Live Photo 图标——放大（点开灯箱）才提示，网格里看起来就是张普通照片，
              // 悬浮照样会播放配对视频，算是个不张扬的小彩蛋
              return \`<div class="cell\${extraClass}" style="\${style}" onclick="openLightbox(\${flatIndex}, false)"><div class="frame-inner live-photo-cell" onmouseenter="this.classList.add('playing');const v=this.querySelector('video');v.currentTime=0;v.play().catch(()=>{})" onmouseleave="this.classList.remove('playing');this.querySelector('video').pause()" ontouchstart="livePhotoTouchStart(this,event)" ontouchend="livePhotoTouchEnd(this,event)" ontouchcancel="livePhotoTouchEnd(this,event)"><img src="\${escAttr(thumbSrc)}" data-src="\${escAttr(p.url)}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.onerror=null;scheduleImageRetry(this,this.src,this.dataset.src)" /><video src="\${p.videoUrl}" loop preload="none" class="cell-live-video"></video></div><span class="frame-year">\${y.year}</span></div>\`;
            }
            return \`<div class="cell\${extraClass}" style="\${style}" onclick="openLightbox(\${flatIndex}, false)"><div class="frame-inner"><img src="\${escAttr(thumbSrc)}" data-src="\${escAttr(p.url)}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.onerror=null;scheduleImageRetry(this,this.src,this.dataset.src)" /></div><span class="frame-year">\${y.year}</span></div>\`;
          }).join('');
          const showMoreBtn = extraCount > 0
            ? \`<button class="show-more-btn" data-total="\${y.photos.length}" onclick="toggleShowMore(this)">展开查看全部 \${y.photos.length} 张 ›</button>\`
            : '';
          return \`
      <div class="year-block" id="year-\${y.year}">
        <div class="year-title">\${y.year} 年 <span class="count">（\${y.photos.length} 份）</span></div>
        <div class="grid">\${cells}</div>
        \${showMoreBtn}
      </div>
    \`;
        }).join('');
        content.querySelectorAll('.cell').forEach((cell) => cellObserver.observe(cell));
        content.querySelectorAll('.cell video[data-src]').forEach((v) => videoLazyObserver.observe(v));

        // "跳到某一年"下拉菜单：照片加载完才知道有哪些年份，这时候再填充菜单内容、解锁按钮
        yearToggle.disabled = false;
        yearMenu.innerHTML = data.years.map((y, i) =>
          '<button style="animation-delay:' + (i * 0.05) + 's" onclick="jumpToYear(' + y.year + ')"><span class="y">' + y.year + ' 年</span>' +
          '<span class="c">' + y.photos.length + ' 份</span></button>'
        ).join('');
        window.jumpToYear = function (year) {
          const el = document.getElementById('year-' + year);
          if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 24, behavior: 'smooth' });
          yearMenu.classList.remove('open');
        };

        fadeIn();
      };

      // 首次加载（骨架屏是 SSR 直出的）或者确实画出过骨架屏，这时候内容区域当前还显示着骨架屏，
      // 要先淡出再换真实内容；网络够快、上面跳过了骨架屏绘制的情况，内容这时候已经是淡出状态了
      // （进 loadMemories 时就 fadeOut 过一次），不用再多走一轮，直接换内容更快也不会有额外的视觉跳动
      if (isFirst || showedSkeleton) {
        fadeOut().then(() => {
          if (seq !== _memSeq) return;
          apply();
        });
      } else {
        apply();
      }
    }).catch((err) => {
      if (seq !== _memSeq) return; // 已经被新的切换顶替，不用管这次失败
      console.error('loadMemories failed', err);
      const showError = () => {
        subtitle.textContent = '加载失败，请稍后重试';
        content.innerHTML = '<div class="empty">这天的回忆没能加载出来，请检查网络后重试</div>';
        fadeIn();
      };
      if (isFirst || showedSkeleton) {
        fadeOut().then(() => {
          if (seq !== _memSeq) return;
          showError();
        });
      } else {
        showError();
      }
    });
  }
  loadMemories(month, day);
`;
const MAP_CSS_HASH = fingerprint(MAP_CSS);
const MAP_JS_HASH = fingerprint(MAP_JS);
const APP_CSS_HASH = fingerprint(APP_CSS);
const APP_JS_HASH = fingerprint(APP_JS);



// ---------- 地图页：把所有带 GPS 的照片打点在地图上 ----------
// 这里用的 token 必须是 public token（pk. 开头），跟服务端反向地理编码用的 secret token 是两个东西，
// 因为这段代码会原样发到浏览器执行，secret token 绝对不能出现在这里
const MAP_HTML = (mapboxPublicToken) => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>足迹 · 那年今日</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link href="https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.css" rel="stylesheet" />
<script src="https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/heic2any/dist/heic2any.min.js" defer></script>
<link rel="stylesheet" href="/static/map-${MAP_CSS_HASH}.css" />
</head>
<body>
  <a class="back-btn" href="/" title="回到回忆墙">
    <svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
  </a>
  <div id="map"></div>
  <div class="map-empty" id="mapEmpty">这一天还没有带定位信息的照片<br />去 /admin/locate-photos 跑一下批量查询，或者等 Cron 任务慢慢处理</div>

<script>window.MAPBOX_TOKEN = ${JSON.stringify(mapboxPublicToken)};</script>
<script src="/static/map-${MAP_JS_HASH}.js" defer></script>
</body>
</html>`;

// ---------- 前端页面 ----------
const HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>那年今日</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&display=swap" rel="stylesheet" />
<script src="https://cdn.jsdelivr.net/npm/heic2any/dist/heic2any.min.js" defer></script>
<link rel="stylesheet" href="/static/app-${APP_CSS_HASH}.css" />
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
    <div class="daily-poem" id="dailyPoem"></div>
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
      <a class="date-toggle" href="/map" id="mapLink" title="看看拍照的地方">
        <svg viewBox="0 0 24 24"><path d="M9 18l-5 2V4l5-2 6 2 5-2v16l-5 2-6-2z"/><line x1="9" y1="2" x2="9" y2="18"/><line x1="15" y1="4" x2="15" y2="20"/></svg>
      </a>
      <button class="date-toggle" id="yearToggle" title="跳到某一年" disabled>
        <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="8.2" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.8" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg>
      </button>
      <button class="date-toggle" id="dateToggle" title="查看某一天">
        <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>
      </button>
    </div>
    <div class="year-menu" id="yearMenu"></div>
    <audio id="ambientAudio" loop preload="none">
      <source src="https://image.cuijianzhuang.com/forest.mp3" type="audio/mpeg" />
    </audio>
    <div class="date-picker" id="datePicker">
      <div class="cal-header">
        <button class="cal-nav-btn" id="calPrevMonth" type="button">‹</button>
        <span class="cal-month-label" id="calMonthLabel"></span>
        <button class="cal-nav-btn" id="calNextMonth" type="button">›</button>
      </div>
      <div class="cal-weekdays">
        <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>
      </div>
      <div class="cal-grid" id="calGrid"></div>
      <div class="row">
        <a class="action-btn" id="datePickerToday" href="/">回到今天</a>
      </div>
    </div>
  </header>
  <div id="fingertip"></div>
  <div id="cursorDot">
    <span class="br tl"></span>
    <span class="br tr"></span>
    <span class="br bl"></span>
    <span class="br brc"></span>
    <span class="center-dot"></span>
  </div>
  <div id="content">
    <div class="skeleton-grid">
      <div class="cell" style="width:150px;--tilt-deg:-3;--sway-dur:4.0s;--sway-delay:0.0s;--enter-delay:0.00s;"><div class="frame-inner"></div></div>
      <div class="cell" style="width:190px;--tilt-deg:-1.5;--sway-dur:4.7s;--sway-delay:0.5s;--enter-delay:0.05s;"><div class="frame-inner"></div></div>
      <div class="cell" style="width:230px;--tilt-deg:0;--sway-dur:5.4s;--sway-delay:1.0s;--enter-delay:0.10s;"><div class="frame-inner"></div></div>
      <div class="cell" style="width:170px;--tilt-deg:1.5;--sway-dur:6.1s;--sway-delay:1.5s;--enter-delay:0.15s;"><div class="frame-inner"></div></div>
      <div class="cell" style="width:210px;--tilt-deg:3;--sway-dur:4.0s;--sway-delay:2.0s;--enter-delay:0.20s;"><div class="frame-inner"></div></div>
    </div>
  </div>

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
      <div class="lightbox-ai-caption" id="lightboxAiCaption"></div>
    </div>
  </div>
  <div class="toast" id="toast"></div>
  <button class="back-to-top" id="backToTop" title="回到顶部">
    <svg viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
  </button>

<script src="/static/app-${APP_JS_HASH}.js" defer></script>
</body>
</html>`;
