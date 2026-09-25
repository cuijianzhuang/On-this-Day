import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExifTiff, parseExifForDisplay } from "../src/lib/exif.js";
import { buildTiff, wrapInJpeg, ascii, short, rationals } from "./helpers/tiff.js";

const DTO = 0x9003, DT = 0x0132, MAKE = 0x010f, MODEL = 0x0110;
const GPS = {
  north: { 0x0001: ascii("N"), 0x0002: rationals([31, 1], [13, 1], [4944, 100]), 0x0003: ascii("E"), 0x0004: rationals([121, 1], [28, 1], [12, 1]) },
  southWest: { 0x0001: ascii("S"), 0x0002: rationals([33, 1], [52, 1], [0, 1]), 0x0003: ascii("W"), 0x0004: rationals([70, 1], [30, 1], [0, 1]) },
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("parseExifTiff：读 ExifIFD 里的 DateTimeOriginal（小端）", () => {
  const tiff = buildTiff({ ifd0: {}, exif: { [DTO]: ascii("2023:06:14 12:34:56") } });
  assert.deepEqual(parseExifTiff(tiff, 0), { year: "2023", month: "06", day: "14", lat: null, lon: null });
});

test("parseExifTiff：大端（MM）同样能读", () => {
  const tiff = buildTiff({ ifd0: {}, exif: { [DTO]: ascii("2019:12:31 23:59:59") } }, { little: false });
  assert.deepEqual(parseExifTiff(tiff, 0), { year: "2019", month: "12", day: "31", lat: null, lon: null });
});

test("parseExifTiff：没有 DateTimeOriginal 时退回 IFD0 的 DateTime", () => {
  const tiff = buildTiff({ ifd0: { [DT]: ascii("2020:02:29 08:00:00") } });
  const r = parseExifTiff(tiff, 0);
  assert.equal(`${r.year}-${r.month}-${r.day}`, "2020-02-29");
});

test("parseExifTiff：两个都有时以 DateTimeOriginal（拍摄时间）为准，不用 DateTime（修改时间）", () => {
  const tiff = buildTiff({
    ifd0: { [DT]: ascii("2024:07:01 00:00:00") },          // 比如 7 月才编辑过
    exif: { [DTO]: ascii("2024:06:14 10:00:00") },          // 实际 6 月拍的
  });
  assert.equal(parseExifTiff(tiff, 0).month, "06");
});

test("parseExifTiff：GPS 度分秒换算成十进制", () => {
  const tiff = buildTiff({ ifd0: {}, exif: { [DTO]: ascii("2023:06:14 12:00:00") }, gps: GPS.north });
  const r = parseExifTiff(tiff, 0);
  assert.ok(near(r.lat, 31 + 13 / 60 + 49.44 / 3600), `lat=${r.lat}`);
  assert.ok(near(r.lon, 121 + 28 / 60 + 12 / 3600), `lon=${r.lon}`);
});

test("parseExifTiff：南纬 / 西经取负号", () => {
  const tiff = buildTiff({ ifd0: {}, exif: { [DTO]: ascii("2023:06:14 12:00:00") }, gps: GPS.southWest });
  const r = parseExifTiff(tiff, 0);
  assert.ok(r.lat < 0 && near(r.lat, -(33 + 52 / 60)));
  assert.ok(r.lon < 0 && near(r.lon, -(70 + 30 / 60)));
});

test("parseExifTiff：只有 GPS、没有日期时只返回坐标（调用方要自己兜底日期）", () => {
  // getCapturedMonthDay 曾经因为这种返回值是真值就跳过了上传时间兜底，照片永远进不了索引
  const r = parseExifTiff(buildTiff({ ifd0: {}, gps: GPS.north }), 0);
  assert.ok(r && r.lat && r.lon);
  assert.equal(r.month, undefined);
  assert.equal(r.day, undefined);
});

test("parseExifTiff：坐标 (0, 0) 视为无效", () => {
  const zero = { 0x0001: ascii("N"), 0x0002: rationals([0, 1], [0, 1], [0, 1]), 0x0003: ascii("E"), 0x0004: rationals([0, 1], [0, 1], [0, 1]) };
  const r = parseExifTiff(buildTiff({ ifd0: {}, exif: { [DTO]: ascii("2023:06:14 12:00:00") }, gps: zero }), 0);
  assert.equal(r.lat, null);
  assert.equal(r.lon, null);
});

test("parseExifTiff：偏移按 TIFF 头计算，TIFF 头不在字节 0 也能读（真实 JPEG 里就不在）", () => {
  const tiff = buildTiff({ ifd0: {}, exif: { [DTO]: ascii("2022:03:05 06:07:08") } });
  const padded = new Uint8Array(37 + tiff.length);
  padded.set(tiff, 37);
  assert.equal(parseExifTiff(padded, 37).day, "05");
});

test("parseExifTiff：什么日期和坐标都没有返回 null", () => {
  assert.equal(parseExifTiff(buildTiff({ ifd0: { [MAKE]: ascii("Apple") } }), 0), null);
});

test("parseExifTiff：乱码 / 截断的数据返回 null 或不含日期，绝不抛异常", () => {
  const junk = new Uint8Array(64).map((_, i) => (i * 37) & 255);
  assert.doesNotThrow(() => parseExifTiff(junk, 0));
  const truncated = buildTiff({ ifd0: {}, exif: { [DTO]: ascii("2023:06:14 12:00:00") } }).slice(0, 20);
  assert.doesNotThrow(() => parseExifTiff(truncated, 0));
  const r = parseExifTiff(truncated, 0);
  assert.ok(r === null || !r.month);
});

test("parseExifForDisplay：从 JPEG 的 APP1 段里找到 EXIF", () => {
  const tiff = buildTiff({
    ifd0: { [MAKE]: ascii("Apple"), [MODEL]: ascii("iPhone 15 Pro") },
    exif: { [DTO]: ascii("2024:06:14 10:00:00"), 0x8827: short(64), 0x829d: rationals([178, 100]) },
  });
  const r = parseExifForDisplay(wrapInJpeg(tiff));
  assert.equal(r.make, "Apple");
  assert.equal(r.model, "iPhone 15 Pro");
  assert.equal(r.iso, 64);
  assert.ok(near(r.aperture, 1.78));
  assert.match(r.dateTime, /^2024:06:14/);
});

test("parseExifForDisplay：直接给 TIFF（HEIC 里抠出来的 Exif 块就是这种）也能解析", () => {
  const r = parseExifForDisplay(buildTiff({ ifd0: { [MODEL]: ascii("Pixel 8") } }, { little: false }));
  assert.equal(r.model, "Pixel 8");
});

test("parseExifForDisplay：不是 JPEG 也不是 TIFF 返回 null", () => {
  assert.equal(parseExifForDisplay(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0])), null); // PNG
  assert.equal(parseExifForDisplay(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);             // 没有 APP1 的 JPEG
});
