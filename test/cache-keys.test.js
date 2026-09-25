import { test } from "node:test";
import assert from "node:assert/strict";
import { memoriesCacheKey, mapPhotosDayCacheKey, mapPhotosAllCacheKey, dayCacheKeys } from "../src/lib/cache-keys.js";
import { SITE_ORIGIN } from "../src/config.js";

test("memories 的 key 只有 lunar=0 / lunar=1 两种", () => {
  assert.equal(memoriesCacheKey("06", "14", false), `${SITE_ORIGIN}/api/memories?month=06&day=14&lunar=0`);
  assert.equal(memoriesCacheKey("06", "14", true), `${SITE_ORIGIN}/api/memories?month=06&day=14&lunar=1`);
});

test("与前端实际请求的 URL 逐字相同——上线后已有的边缘缓存条目仍然有效，不会整体失效一次", () => {
  // app.js loadMemories 发的就是这个顺序：month、day、lunar
  const fromFrontend = new URL("/api/memories?month=06&day=14&lunar=0", SITE_ORIGIN).toString();
  assert.equal(memoriesCacheKey("06", "14", false), fromFrontend);
});

test("清某一天的缓存时，覆盖了写入方可能写过的每一个 key", () => {
  const written = new Set([
    memoriesCacheKey("06", "14", false),
    memoriesCacheKey("06", "14", true),
    mapPhotosDayCacheKey("06", "14"),
  ]);
  assert.deepEqual(new Set(dayCacheKeys("06", "14")), written);
});

test("不同日期的 key 互不相同", () => {
  assert.notEqual(memoriesCacheKey("06", "14", false), memoriesCacheKey("06", "15", false));
  assert.notEqual(mapPhotosDayCacheKey("01", "02"), mapPhotosDayCacheKey("02", "01"));
});

test("全库地图：不带年份 / 带年份", () => {
  assert.equal(mapPhotosAllCacheKey(), `${SITE_ORIGIN}/api/map-photos`);
  assert.equal(mapPhotosAllCacheKey(null), `${SITE_ORIGIN}/api/map-photos`);
  assert.equal(mapPhotosAllCacheKey("2023"), `${SITE_ORIGIN}/api/map-photos?year=2023`);
});
