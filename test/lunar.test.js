import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { solarToLunar, lunarToSolar, lunarLabel, lunarDayName } from "../src/lib/lunar.js";

// 这个文件里有两类测试，缺一不可：
//   · 外部参照：拿独立数据源（fixtures/lunar-months.txt，由 Python 库 lunardate 生成）逐月比对。
//     这是唯一能抓住"压缩表抄错一位"的测试——表抄错了照样自洽，只有和外部数据比才露馅。
//     重新生成：pip install lunardate && python3 test/fixtures/gen-lunar-months.py
//   · 行为约定：闰月不存在时返回 null、超出表范围返回 null 这类边界语义。

const MONTHS = readFileSync(new URL("./fixtures/lunar-months.txt", import.meta.url), "utf8")
  .split("\n").filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const [year, start, leap, lens] = l.trim().split(/\s+/);
    return { year: +year, start: Date.UTC(+start.slice(0, 4), +start.slice(4, 6) - 1, +start.slice(6, 8)), leap: +leap, lens };
  });
const ymd = (t) => { const d = new Date(t); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; };

// 已知日期用的是公开可查的春节 / 闰月起始日，不是用本实现反推出来的，否则测试等于自证
test("春节（正月初一）落在已知的公历日期", () => {
  for (const [y, m, d] of [[2020, 1, 25], [2023, 1, 22], [2024, 2, 10], [2025, 1, 29]]) {
    assert.deepEqual(solarToLunar(y, m, d), { year: y, month: 1, day: 1, isLeap: false }, `${y}-${m}-${d}`);
  }
});

test("除夕是上一个农历年的最后一天", () => {
  // 2025-01-28 是 2024 年腊月廿九（这年腊月只有 29 天，没有三十）
  assert.deepEqual(solarToLunar(2025, 1, 28), { year: 2024, month: 12, day: 29, isLeap: false });
});

test("闰月：识别出闰月，且月份号不前进", () => {
  assert.deepEqual(solarToLunar(2020, 5, 23), { year: 2020, month: 4, day: 1, isLeap: true });  // 闰四月初一
  assert.deepEqual(solarToLunar(2023, 3, 22), { year: 2023, month: 2, day: 1, isLeap: true });  // 闰二月初一
  assert.deepEqual(solarToLunar(2025, 7, 25), { year: 2025, month: 6, day: 1, isLeap: true });  // 闰六月初一
  // 闰月之前的普通同名月
  assert.deepEqual(solarToLunar(2023, 2, 20), { year: 2023, month: 2, day: 1, isLeap: false });
});

test("中秋", () => {
  assert.deepEqual(solarToLunar(2024, 9, 17), { year: 2024, month: 8, day: 15, isLeap: false });
});

test("外部参照：1900–2049 每个农历月的起止日、大小月、闰月位置都和独立数据源一致", () => {
  assert.equal(MONTHS.length, 150); // 农历 1900–2049，压缩表的完整范围
  let months = 0;
  for (const { year, start, leap, lens } of MONTHS) {
    let t = start, m = 0;
    for (let i = 0; i < lens.length; i++) {
      // 闰月紧跟在同名普通月之后，月份号不前进
      const isLeap = leap > 0 && m === leap && i > 0 && lens.length === 13 && i === leap;
      if (!isLeap) m++;
      const len = lens[i] === "L" ? 30 : 29;
      const tag = `${year} ${isLeap ? "闰" : ""}${m}月`;
      assert.deepEqual(solarToLunar(...Object.values(ymd(t))), { year, month: m, day: 1, isLeap }, `${tag} 初一`);
      assert.deepEqual(solarToLunar(...Object.values(ymd(t + (len - 1) * 86400000))), { year, month: m, day: len, isLeap }, `${tag} 最后一天应是第 ${len} 天`);
      assert.deepEqual(lunarToSolar(year, m, 1, isLeap), ymd(t), `${tag} 初一 反推公历`);
      if (len === 29) assert.equal(lunarToSolar(year, m, 30, isLeap), null, `${tag} 是小月，没有三十`);
      t += len * 86400000;
      months++;
    }
    assert.equal(m, 12, `${year} 应有 12 个普通月`);
  }
  assert.ok(months > 1800);
});

test("往返一致：1901–2048 每一天 公历→农历→公历 都回到原日期", () => {
  // 这条覆盖整张压缩表（五万多天），任何一年的大小月 / 闰月位读错都会在这里暴露
  let checked = 0;
  for (let t = Date.UTC(1901, 0, 1); t < Date.UTC(2049, 0, 1); t += 86400000) {
    const d = new Date(t);
    const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const l = solarToLunar(y, m, day);
    assert.ok(l, `${y}-${m}-${day} 应在表范围内`);
    const back = lunarToSolar(l.year, l.month, l.day, l.isLeap);
    assert.deepEqual(back, { year: y, month: m, day }, `${y}-${m}-${day} → ${JSON.stringify(l)}`);
    checked++;
  }
  assert.ok(checked > 54000);
});

test("lunarToSolar：请求一个当年不存在的闰月返回 null，而不是退化成普通月（PR #125 修过的 bug）", () => {
  assert.equal(lunarToSolar(2023, 4, 1, true), null); // 2023 的闰月是闰二月
  assert.equal(lunarToSolar(2024, 4, 1, true), null); // 2024 没有闰月
  assert.deepEqual(lunarToSolar(2023, 2, 1, true), { year: 2023, month: 3, day: 22 });
});

test("lunarToSolar：日子超出当月天数返回 null（小月没有三十）", () => {
  assert.equal(lunarToSolar(2024, 12, 30, false), null);
  assert.deepEqual(lunarToSolar(2024, 12, 29, false), { year: 2025, month: 1, day: 28 });
});

test("超出 1900–2049 表范围返回 null", () => {
  assert.equal(solarToLunar(1899, 12, 31), null);
  assert.equal(solarToLunar(1900, 1, 30), null); // 表的基准是 1900-01-31
  assert.equal(solarToLunar(2050, 6, 1), null);
  assert.equal(lunarToSolar(1899, 1, 1, false), null);
  assert.equal(lunarToSolar(2050, 1, 1, false), null);
});

test("农历日期的中文写法", () => {
  const names = { 1: "初一", 9: "初九", 10: "初十", 11: "十一", 19: "十九", 20: "二十", 21: "廿一", 29: "廿九", 30: "三十" };
  for (const [d, name] of Object.entries(names)) assert.equal(lunarDayName(Number(d)), name, `第 ${d} 天`);
  assert.equal(lunarLabel({ month: 8, day: 15, isLeap: false }), "八月十五");
  assert.equal(lunarLabel({ month: 2, day: 1, isLeap: true }), "闰二月初一");
  assert.equal(lunarLabel({ month: 1, day: 10, isLeap: false }), "正月初十");
  assert.equal(lunarLabel({ month: 11, day: 20, isLeap: false }), "冬月二十");
  assert.equal(lunarLabel({ month: 12, day: 30, isLeap: false }), "腊月三十");
});
