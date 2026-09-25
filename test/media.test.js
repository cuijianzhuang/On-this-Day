import { test } from "node:test";
import assert from "node:assert/strict";
import { dateFromFilename, pairLivePhotos, IMAGE_EXT, VIDEO_EXT } from "../src/lib/media.js";

test("dateFromFilename：常见相机 / 手机命名", () => {
  assert.deepEqual(dateFromFilename("IMG_20260627_141422.PNG"), { year: "2026", month: "06", day: "27" });
  assert.deepEqual(dateFromFilename("PXL_20231231_235959123.jpg"), { year: "2023", month: "12", day: "31" });
  assert.deepEqual(dateFromFilename("VID_19991231_000000.mp4"), { year: "1999", month: "12", day: "31" });
  assert.deepEqual(dateFromFilename("Screenshot_20240101-083000.png"), { year: "2024", month: "01", day: "01" });
});

test("dateFromFilename：没有日期的纯序号命名返回 null（交给 EXIF 兜底）", () => {
  assert.equal(dateFromFilename("IMG_1017.JPG"), null);
  assert.equal(dateFromFilename("DSC_0001.heic"), null);
  assert.equal(dateFromFilename("2024-06-14.jpg"), null); // 带分隔符的不认
});

test("dateFromFilename：月 / 日越界的数字串不算日期", () => {
  assert.equal(dateFromFilename("VID_20231301_1.mov"), null); // 13 月
  assert.equal(dateFromFilename("IMG_20240000_1.jpg"), null); // 0 日
  assert.equal(dateFromFilename("IMG_20240132_1.jpg"), null); // 32 日
});

test("dateFromFilename：毫秒时间戳命名不会被误判成日期", () => {
  // 1719475200000 里第一个 19xx 开头的 8 位串是 19475200 → 52 月，被校验挡掉
  assert.equal(dateFromFilename("1719475200000.jpg"), null);
});

test("dateFromFilename：只看第一个匹配（第一个无效就不再往后找）", () => {
  // 这是现有行为的记录，不是期望行为的背书：20999999 被判无效后，
  // 后面真正的 20240614 不会再被尝试。实际相机命名里还没见过这种情况
  assert.equal(dateFromFilename("20999999_20240614.jpg"), null);
});

test("dateFromFilename：不存在的日子（2 月 31 日）目前不会被拦下", { todo: "只校验了 1–31，没按月份校验天数；要修需要同时决定这类照片该落到哪一天" }, () => {
  assert.equal(dateFromFilename("IMG_20240231_1.jpg"), null);
});

test("扩展名判断", () => {
  for (const f of ["a.jpg", "a.JPEG", "a.png", "a.HEIC", "a.gif", "a.webp"]) assert.ok(IMAGE_EXT.test(f), f);
  for (const f of ["a.mov", "a.MP4"]) assert.ok(VIDEO_EXT.test(f), f);
  for (const f of ["a.txt", "a.jpg.bak", "a.aae"]) assert.ok(!IMAGE_EXT.test(f) && !VIDEO_EXT.test(f), f);
});

const P = "Photos/MobileBackup/iPhone/2023/06/";

test("pairLivePhotos：同目录同名的图片 + 视频合并成一条 live", () => {
  const out = pairLivePhotos([
    { key: P + "IMG_1234.HEIC", size: 100, uploaded: "t1" },
    { key: P + "IMG_1234.MOV", size: 900, uploaded: "t2" },
  ], "2023");
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "live");
  assert.equal(out[0].key, P + "IMG_1234.HEIC");               // key 用静态图
  assert.equal(out[0].url, "/img/" + encodeURIComponent(P + "IMG_1234.HEIC"));
  assert.equal(out[0].videoUrl, "/img/" + encodeURIComponent(P + "IMG_1234.MOV"));
  assert.equal(out[0].size, 100);
  assert.equal(out[0].year, "2023");
});

test("pairLivePhotos：不同目录的同名文件不能配对（iPhone 序号会循环重用）", () => {
  const out = pairLivePhotos([
    { key: "Photos/MobileBackup/iPhone/2023/06/IMG_0001.JPG" },
    { key: "Photos/MobileBackup/iPhone/2024/01/IMG_0001.MOV" },
  ], "2023");
  assert.deepEqual(out.map((e) => e.type).sort(), ["image", "video"]);
});

test("pairLivePhotos：落单的图片和视频各自保留原类型", () => {
  const out = pairLivePhotos([{ key: P + "a.jpg" }, { key: P + "b.mp4" }], "2023");
  const byKey = Object.fromEntries(out.map((e) => [e.key, e.type]));
  assert.deepEqual(byKey, { [P + "a.jpg"]: "image", [P + "b.mp4"]: "video" });
  assert.ok(out.every((e) => !("videoUrl" in e)));
});

test("pairLivePhotos：宽高只在两者都有时才透传", () => {
  const [withDims] = pairLivePhotos([{ key: P + "a.jpg", width: 300, height: 400 }], "2023");
  assert.equal(withDims.width, 300);
  assert.equal(withDims.height, 400);
  const [noDims] = pairLivePhotos([{ key: P + "b.jpg", width: 300, height: null }], "2023");
  assert.ok(!("width" in noDims) && !("height" in noDims));
});

test("pairLivePhotos：文件名里的特殊字符在 url 里被编码", () => {
  const [e] = pairLivePhotos([{ key: P + "照片 #3.jpg" }], "2023");
  assert.equal(e.url, "/img/" + encodeURIComponent(P + "照片 #3.jpg"));
  assert.ok(!e.url.includes("#"));
});
