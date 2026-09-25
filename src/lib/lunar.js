// 农历 ↔ 公历换算。纯函数、零依赖——worker.js 和测试都直接 import 这里。

// ── 农历转换（1900–2049）─────────────────────────────────────────────────────
// 经典压缩表：每年一个整数，低 4 位 = 闰月月份（0 为无闰），bit4~bit15 = 十二个月大小月
// （1 大月 30 天 / 0 小月 29 天），bit16 = 闰月大小。基准：1900-01-31 为庚子年正月初一
const LUNAR_INFO = [
  0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,//1900-1909
  0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,//1910-1919
  0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,//1920-1929
  0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,//1930-1939
  0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,//1940-1949
  0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,//1950-1959
  0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,//1960-1969
  0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b5a0,0x195a6,//1970-1979
  0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,//1980-1989
  0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x05ac0,0x0ab60,0x096d5,0x092e0,//1990-1999
  0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,//2000-2009
  0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,//2010-2019
  0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,//2020-2029
  0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,//2030-2039
  0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,//2040-2049
];
const LUNAR_EPOCH_UTC = Date.UTC(1900, 0, 31);
function _leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }
function _leapDays(y) { return _leapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0; }
function _monthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
function _lunarYearDays(y) {
  let sum = 348; // 12 × 29
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
  return sum + _leapDays(y);
}

// 公历 → 农历，超出表范围返回 null
export function solarToLunar(sy, sm, sd) {
  let offset = Math.floor((Date.UTC(sy, sm - 1, sd) - LUNAR_EPOCH_UTC) / 86400000);
  if (offset < 0) return null;
  let ly = 1900;
  for (; ly < 2050; ly++) {
    const yd = _lunarYearDays(ly);
    if (offset < yd) break;
    offset -= yd;
  }
  if (ly >= 2050) return null;
  const leap = _leapMonth(ly);
  let isLeap = false;
  let lm = 1;
  while (lm <= 12) {
    let days;
    if (leap > 0 && lm === leap + 1 && !isLeap) {
      // 闰月排在第 leap 个月之后，月份号不前进
      isLeap = true;
      days = _leapDays(ly);
      lm--;
    } else {
      days = _monthDays(ly, lm);
      isLeap = false;
    }
    if (offset < days) break;
    offset -= days;
    lm++;
  }
  return { year: ly, month: lm, day: offset + 1, isLeap };
}

// 农历 → 公历；该年没有这个闰月/这一天（如某年腊月没有三十）时返回 null
export function lunarToSolar(ly, lm, ld, isLeapMonth) {
  if (ly < 1900 || ly >= 2050) return null;
  const leap = _leapMonth(ly);
  // 请求的闰月这年根本不存在（比如闰四月，但这年真正的闰月是闰五月或者压根没有闰月）时必须
  // 直接判定失败——退化成"当年普通月份"会让调用方把这年当成一次真实的闰月纪念日/照片匹配，
  // 于是闰月纪念日每年都提前庆祝、"农历同日"匹配也会混进不该出现的普通月同日照片
  if (isLeapMonth && leap !== lm) return null;
  const dm = isLeapMonth ? _leapDays(ly) : _monthDays(ly, lm);
  if (ld > dm) return null;
  let offset = 0;
  for (let y = 1900; y < ly; y++) offset += _lunarYearDays(y);
  for (let m = 1; m < lm; m++) {
    offset += _monthDays(ly, m);
    if (leap === m) offset += _leapDays(ly);
  }
  if (isLeapMonth) offset += _monthDays(ly, lm);
  offset += ld - 1;
  const date = new Date(LUNAR_EPOCH_UTC + offset * 86400000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export const LUNAR_MONTH_NAMES = ['正','二','三','四','五','六','七','八','九','十','冬','腊'];
export function lunarDayName(d) {
  if (d === 10) return '初十';
  if (d === 20) return '二十';
  if (d === 30) return '三十';
  const tens = ['初','十','廿','三'];
  const ones = ['十','一','二','三','四','五','六','七','八','九'];
  return tens[Math.floor(d / 10)] + ones[d % 10];
}
export function lunarLabel(l) {
  return `${l.isLeap ? '闰' : ''}${LUNAR_MONTH_NAMES[l.month - 1]}月${lunarDayName(l.day)}`;
}
