CREATE TABLE IF NOT EXISTS photo_scores (
  key TEXT PRIMARY KEY,
  score INTEGER,
  has_face INTEGER NOT NULL DEFAULT 0,
  caption TEXT,
  raw_response TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS photo_places (
  key TEXT PRIMARY KEY,
  lat REAL,
  lon REAL,
  name TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- R2 里所有照片/视频的索引，靠 R2 Event Notification -> Queue -> queue() consumer 增量维护，
-- 新文件一上传就会被索引进来；上线前已经存在的旧文件需要跑一次 /admin/backfill-photos-index 回填。
-- 有了这张表，matchPhotosForDay 就能直接按 month/day 查表，不用再每次都 list() 扫一遍 R2（A 类操作，比读单个对象贵很多）
CREATE TABLE IF NOT EXISTS photos_index (
  key TEXT PRIMARY KEY,
  type TEXT NOT NULL,    -- 'image' | 'video'
  year TEXT NOT NULL,
  month TEXT NOT NULL,
  day TEXT NOT NULL,     -- 拍摄日：文件名带日期的直接解析，没带的靠 EXIF/R2 上传时间兜底（跟 getCapturedMonthDay 同一套逻辑）
  size INTEGER,
  uploaded TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_photos_index_month_day ON photos_index(month, day);
