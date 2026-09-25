// 边缘缓存的 key。写入方（handler）和清除方（purgeDayCache）都从这里取，
// 结构上保证两边拼出的是同一个字符串。
//
// 之前写入方直接用 url.toString()、清除方手工列举变体：前端加了 lunar 参数以后清除方漏了
// lunar=0，公历模式（最常用）的缓存一直清不掉，新照片上传后要干等 30 分钟才出现。
// 而且按原样 URL 当 key，参数顺序不同、多带一个参数，都会各自生成一条永远清不掉的缓存。
//
// 这里的 key 只由"真正影响响应内容的参数"组成，且参数顺序固定。
import { SITE_ORIGIN } from "../config.js";

// /api/memories 的响应只随 lunar 是否为 "1" 变化（见 handleMemories），所以归一成 0/1 两个变体
export function memoriesCacheKey(month, day, includeLunar) {
  return `${SITE_ORIGIN}/api/memories?month=${month}&day=${day}&lunar=${includeLunar ? 1 : 0}`;
}

export function mapPhotosDayCacheKey(month, day) {
  return `${SITE_ORIGIN}/api/map-photos?month=${month}&day=${day}`;
}

// 全库足迹；year 可选（轨迹回放按年取）
export function mapPhotosAllCacheKey(year) {
  return `${SITE_ORIGIN}/api/map-photos${year ? `?year=${year}` : ""}`;
}

// 某一天的照片有变动时要清掉的全部 key
export function dayCacheKeys(month, day) {
  return [
    memoriesCacheKey(month, day, false),
    memoriesCacheKey(month, day, true),
    mapPhotosDayCacheKey(month, day),
  ];
}
