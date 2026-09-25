// 测试用的 TIFF / JPEG 构造器：按字节把 EXIF 结构拼出来，而不是往仓库里塞二进制样本——
// 这样每个测试用例里"这张图带了哪些标签"一眼就能看清，也能精确构造出边界情况
// （大端、GPS 南纬西经、只有 GPS 没有日期、TIFF 头不在偏移 0……）。

const ASCII = 2, SHORT = 3, LONG = 4, RATIONAL = 5;
export const T = { ASCII, SHORT, LONG, RATIONAL };

export const ascii = (s) => ({ type: ASCII, count: s.length + 1, bytes: [...Buffer.from(s + "\0", "latin1")] });
export const short = (v) => ({ type: SHORT, count: 1, short: v });
export const rationals = (...pairs) => ({ type: RATIONAL, count: pairs.length, rationals: pairs });

/**
 * ifds: { ifd0: {tag: entry}, exif?: {...}, gps?: {...} }
 * 自动生成 ExifIFDPointer(0x8769) / GPSInfoIFDPointer(0x8825)。
 * 返回从 TIFF 头开始的 Uint8Array。
 */
export function buildTiff(ifds, { little = true } = {}) {
  const buf = new Uint8Array(2048);
  const u16 = (o, v) => { if (little) { buf[o] = v & 255; buf[o + 1] = v >> 8; } else { buf[o] = v >> 8; buf[o + 1] = v & 255; } };
  const u32 = (o, v) => {
    const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    (little ? b.reverse() : b).forEach((x, i) => (buf[o + i] = x));
  };

  buf[0] = buf[1] = little ? 0x49 : 0x4d;
  u16(2, 42);
  u32(4, 8); // IFD0 紧跟文件头

  // 固定布局：IFD0@8、ExifIFD@300、GPS@600，数据区从 900 开始往后分配
  const at = { ifd0: 8, exif: 300, gps: 600 };
  let data = 900;
  const ifd0 = { ...ifds.ifd0 };
  if (ifds.exif) ifd0[0x8769] = { type: LONG, count: 1, long: at.exif };
  if (ifds.gps) ifd0[0x8825] = { type: LONG, count: 1, long: at.gps };

  const writeIfd = (off, entries) => {
    const tags = Object.keys(entries).map(Number).sort((a, b) => a - b);
    u16(off, tags.length);
    tags.forEach((tag, i) => {
      const e = off + 2 + i * 12, v = entries[tag];
      u16(e, tag); u16(e + 2, v.type); u32(e + 4, v.count);
      if (v.long !== undefined) u32(e + 8, v.long);
      else if (v.short !== undefined) u16(e + 8, v.short);
      else if (v.rationals) {
        u32(e + 8, data);
        for (const [n, d] of v.rationals) { u32(data, n); u32(data + 4, d); data += 8; }
      } else if (v.bytes.length <= 4) {
        v.bytes.forEach((b, j) => (buf[e + 8 + j] = b)); // 放得下就直接内联在 value 字段
      } else {
        u32(e + 8, data);
        v.bytes.forEach((b, j) => (buf[data + j] = b));
        data += v.bytes.length;
      }
    });
    u32(off + 2 + tags.length * 12, 0); // next IFD = 0
  };

  writeIfd(at.ifd0, ifd0);
  if (ifds.exif) writeIfd(at.exif, ifds.exif);
  if (ifds.gps) writeIfd(at.gps, ifds.gps);
  return buf.slice(0, data);
}

// 把 TIFF 包进 JPEG 的 APP1 "Exif\0\0" 段，前面再垫一个 APP0，模拟真实 JPEG 文件头
export function wrapInJpeg(tiff) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const exifHeader = [...Buffer.from("Exif\0\0", "latin1")];
  const len = 2 + exifHeader.length + tiff.length;
  const app1 = [0xff, 0xe1, len >> 8, len & 255, ...exifHeader, ...tiff];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xda, 0x00, 0x02]);
}
