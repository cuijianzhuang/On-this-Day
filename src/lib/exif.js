// EXIF 解析：只吃字节数组，不碰 R2/网络。读字节的那一层（readJpegExifDate 等）留在 worker.js。

// 解析 iinf box 内容，找类型为 "Exif" 的 item，返回它的 item_ID
export function findExifItemId(buf, start, end) {
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

export function parseExifTiff(buf, tiffStart) {
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
export function parseExifForDisplay(buf) {
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
