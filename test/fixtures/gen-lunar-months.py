# 重新生成 lunar-months.txt：
#   pip install lunardate ephem && python3 test/fixtures/gen-lunar-months.py
#
# 数据来源分两层：
#   1. lunardate（独立实现的 Python 农历库）提供月序与闰月结构；
#   2. ephem（天体力学模型）逐个算出合朔时刻，作为裁判校正 lunardate 的月初一。
#      农历规则是"合朔所在的那一天为初一"（1929 年起按东八区，此前按北京地方平时 UTC+7:45:40）。
#      只有合朔离午夜超过 60 分钟、结果没有歧义时才用天文结果覆盖；离午夜几分钟的临界情况
#      超出了 ephem 简化模型的精度，保留 lunardate（它和实际颁行的历书一致）。
#
# 实测这一步校正了 lunardate 的一处错误：1954 年冬月初一，合朔在北京时间 20:30，
# 应为 1954-11-25，lunardate 给的是 11-26（src/lib/lunar.js 的表本来就是对的）。
import datetime, warnings
from collections import OrderedDict
warnings.filterwarnings("ignore")
import ephem
from lunardate import LunarDate

FIRST, LAST = datetime.date(1900, 1, 31), datetime.date(2050, 3, 1)  # 覆盖压缩表的完整范围：农历 1900–2049 年

# 天文合朔：日期 → 距当地午夜的分钟数
astro = {}
d = ephem.Date(FIRST.strftime("%Y/%m/%d"))
while True:
    nm = ephem.next_new_moon(d)
    utc = nm.datetime()
    if utc.date() > LAST:
        break
    off = datetime.timedelta(hours=8) if utc.year >= 1929 else datetime.timedelta(hours=7, minutes=45, seconds=40)
    local = utc + off
    mins = local.hour * 60 + local.minute
    astro[local.date()] = min(mins, 1440 - mins)
    d = ephem.Date(nm + 1)

starts = []
day = FIRST
while day <= LAST:
    l = LunarDate.fromSolarDate(day.year, day.month, day.day)
    if l.day == 1:
        starts.append([day, l.year, l.month, bool(l.isLeapMonth)])
    day += datetime.timedelta(days=1)

for s in starts:
    if s[0] in astro:
        continue
    for delta in (-1, 1):
        cand = s[0] + datetime.timedelta(days=delta)
        if cand in astro and astro[cand] > 60:
            print(f"校正：{s[1]} 年 {'闰' if s[3] else ''}{s[2]} 月初一 {s[0]} → {cand}（合朔距午夜 {astro[cand]} 分钟）")
            s[0] = cand

years = OrderedDict()
for i in range(len(starts) - 1):
    sd, ly, lm, leap = starts[i]
    years.setdefault(ly, []).append((sd, lm, leap, (starts[i + 1][0] - sd).days))

out = [
    "# 农历月表：每个农历年一行 —— 年  正月初一的公历日期  闰月(0=无)  各月天数（L=30 S=29，闰月紧跟在同名月之后）",
    "# 由 test/fixtures/gen-lunar-months.py 生成（lunardate 提供月序，ephem 天文合朔校正月初一），",
    "# 用来钉住 src/lib/lunar.js 压缩表里的每一位。不要手改，改了就失去「外部参照」的意义。",
]
for ly, months in years.items():
    if ly < 1900 or ly > 2049 or months[0][1] != 1 or months[0][2]:
        continue
    leap = next((m for _, m, lp, _ in months if lp), 0)
    lens = "".join("L" if n == 30 else "S" for *_, n in months)
    out.append(f"{ly} {months[0][0].strftime('%Y%m%d')} {leap:2d} {lens}")

here = __file__.rsplit("/", 1)[0]
open(f"{here}/lunar-months.txt", "w").write("\n".join(out) + "\n")
print(len(out) - 3, "个农历年")
