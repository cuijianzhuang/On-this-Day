// 照片/视频文件层面的纯逻辑：扩展名判断、Live Photo 配对、从文件名解析拍摄日期。

export const IMAGE_EXT = /\.(jpe?g|png|heic|gif|webp)$/i;
export const VIDEO_EXT = /\.(mov|mp4)$/i;

// Live Photo 配对：iPhone 的 Live Photo 在 R2 里是两个独立文件——同目录、文件名（去掉
// 扩展名）完全相同的一张 HEIC/JPEG + 一段 MOV，例如 IMG_1234.HEIC 配 IMG_1234.MOV。
// 把同一批文件（已经按 IMAGE_EXT/VIDEO_EXT 过滤过）按"完整 key 去扩展名"分组，
// 配对成功的合并成一条 type: 'live' 记录（带 url 静态图 + videoUrl 配对视频），
// 没配对到的图片/视频各自按原来的 image/video 类型展示，不受影响
export function pairLivePhotos(objs, year) {
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
        // 宽高可能还没量到（这张图的等比缩略图从没生成过），那就不发——
        // 前端拿不到就退回原来的 1:1 占位，不是错误状态
        ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
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
        ...(obj.width && obj.height ? { width: obj.width, height: obj.height } : {}),
        year,
      });
    }
  }
  return entries;
}

// 从文件名里解析拍摄日期（IMG_20260627_141422.PNG → 2026/06/27），解析不出返回 null。
// 只认 19xx/20xx 开头的连续 8 位数字，并校验月 1–12、日 1–31——毫秒时间戳之类的长数字串
// 很容易碰巧匹配出一个"日期"，靠这层校验挡掉大部分误判。
// 注意只看**第一个**匹配：第一个匹配校验失败就直接返回 null，不会继续往后找。
export function dateFromFilename(basename) {
  const m = basename.match(/((?:19|20)\d{2})(\d{2})(\d{2})/); // YYYYMMDD
  if (!m) return null;
  const month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: m[1], month: m[2], day: m[3] };
}
