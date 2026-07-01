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
import { createHash } from "node:crypto";
import { WorkflowEntrypoint } from "cloudflare:workers";

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

    if (url.pathname === "/admin/backfill-workflows") {
      return handleBackfillWorkflows(request, env, url);
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

    if (url.pathname === "/api/poem") {
      return handlePoem(request, env, url);
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

    // 其余请求（/、/favicon.svg、/app.css、/app.js 等）交给 Static Assets CDN
    return env.ASSETS.fetch(request);
  },

  // Cron 定时任务：每次只处理一小批未打分/未查地点的照片，跑在用户访问之外，
  // 不会跟页面请求共享同一次调用的子请求预算，自然就不会撞到 Workers 的子请求上限
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackgroundMaintenance(env));
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

async function handleExif(request, env, url) {
  const key = url.searchParams.get("key");
  if (!key || key.length > 500) return new Response("Bad Request", { status: 400 });
  // 只读前 64KB 就够解析 EXIF（EXIF 段在文件头部）
  const obj = await env.PHOTOS.get(key, { range: { offset: 0, length: 65536 } });
  if (!obj) return new Response("Not Found", { status: 404 });
  const buf = new Uint8Array(await obj.arrayBuffer());
  const exif = parseExifForDisplay(buf) || {};
  if (obj.size) exif.fileSize = obj.size;
  return new Response(JSON.stringify(exif), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      "access-control-allow-origin": "*",
    },
  });
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

// 历史积压图片批量触发 Workflow，解决两个 backlog 场景：
//   1. 普通 JPEG 未打分：直接触发，Workflow step 3 打分
//   2. 历史 HEIC 无预览图（cron 只转今天的）：Workflow step 2 先转码，step 3 再打分
// 每次调用触发 limit 张（默认 50，上限 200），多次调用直到 remaining=0
async function handleBackfillWorkflows(request, env, url) {
  const token = url.searchParams.get("token");
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
    return new Response("Forbidden", { status: 403 });
  }

  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

  // 找出 photos_index 里有记录、但 photo_scores 里还没有打分结果的图片
  const { results } = await env.DB.prepare(
    "SELECT pi.key FROM photos_index pi " +
    "LEFT JOIN photo_scores ps ON pi.key = ps.key " +
    "WHERE pi.type = 'image' AND ps.key IS NULL " +
    "LIMIT ?"
  ).bind(limit).all();

  for (const { key } of results) {
    await env.PHOTO_WORKFLOW.create({ params: { key } });
  }

  // 计算剩余未处理数量（本批触发后还剩多少）
  const { results: countRows } = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM photos_index pi " +
    "LEFT JOIN photo_scores ps ON pi.key = ps.key " +
    "WHERE pi.type = 'image' AND ps.key IS NULL"
  ).all();
  const remaining = Math.max(0, (countRows[0]?.cnt ?? 0) - results.length);

  return Response.json({ triggered: results.length, remaining });
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

// ---------- 地图页：把所有带 GPS 的照片打点在地图上 ----------
// 这里用的 token 必须是 public token（pk. 开头），跟服务端反向地理编码用的 secret token 是两个东西，
// 因为这段代码会原样发到浏览器执行，secret token 绝对不能出现在这里
const MAP_HTML = (mapboxPublicToken) => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<title>足迹 · 那年今日</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link href="https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.css" rel="stylesheet" />
<script src="https://api.mapbox.com/mapbox-gl-js/v3.6.0/mapbox-gl.js"></script>
<script src="https://cdn.jsdelivr.net/npm/heic2any/dist/heic2any.min.js" defer></script>
<link rel="stylesheet" href="/map.css" />
</head>
<body>
  <a class="back-btn" href="/" title="回到回忆墙">
    <svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
  </a>
  <div id="map"></div>
  <div class="map-empty" id="mapEmpty">这一天还没有带定位信息的照片<br />去 /admin/locate-photos 跑一下批量查询，或者等 Cron 任务慢慢处理</div>

<script>window.MAPBOX_TOKEN = ${JSON.stringify(mapboxPublicToken)};</script>
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

    const reactions_v2 = (await this.state.storage.get("reactions_v2")) || {};
    const { count, list } = this._usersInfo();
    server.send(JSON.stringify({ type: "init", count, reactions_v2, you: userId, list }));
    this._broadcast({ type: "users", count, list }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    try {
      const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      if (msg.type === "react" && typeof msg.key === "string" && msg.key.length < 300) {
        const VALID_EMOJIS = new Set(['👍','❤️','😍','😂','😮','😢','🔥','✨']);
        const emoji = VALID_EMOJIS.has(msg.emoji) ? msg.emoji : '❤️';
        const reactions_v2 = (await this.state.storage.get("reactions_v2")) || {};
        if (!reactions_v2[msg.key]) reactions_v2[msg.key] = {};
        reactions_v2[msg.key][emoji] = (reactions_v2[msg.key][emoji] || 0) + 1;
        await this.state.storage.put("reactions_v2", reactions_v2);
        const count = reactions_v2[msg.key][emoji];
        this._broadcast({ type: "react", key: msg.key, emoji, count });
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
    const meta = await step.do("index", async () => {
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
    await step.do("purge-cache", async () => {
      await purgeDayCache(meta.month, meta.day);
    });
  }
}
