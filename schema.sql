CREATE TABLE IF NOT EXISTS photo_scores (
  key TEXT PRIMARY KEY,
  score INTEGER,
  has_face INTEGER NOT NULL DEFAULT 0,
  caption TEXT,
  raw_response TEXT,
  updated_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0  -- 打分次数：文案一直不达标（AI 失败/翻不成中文）的照片到上限后退出自动重试队列；老库由 ensureAuxTables() 运行时 ALTER 补列
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
CREATE INDEX IF NOT EXISTS idx_photos_index_year ON photos_index(year); -- /api/recap 按年查

-- 表态计数镜像（权威数据在各日期房间的 DO storage 里，这里是跨房间聚合用的副本，
-- 由 MemoryRoom 在每次 react/unreact 时同步写入；用于"全家最爱"页面）
-- 运行时由 ensureAuxTables() 自动建表，这里只做文档记录
CREATE TABLE IF NOT EXISTS photo_reactions (
  key TEXT NOT NULL,
  emoji TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, emoji)
);

-- 照片手记（旧版，单条覆盖式）：已废弃，不再写入。只保留给 ensureAuxTables() 里
-- 那条一次性迁移 SQL 读取，把老数据搬进下面的 photo_comments，不删表以免丢历史数据
CREATE TABLE IF NOT EXISTS photo_notes (
  key TEXT PRIMARY KEY,
  note TEXT NOT NULL,
  updated_at TEXT
);

-- 照片手记（现版，多人评论串）：每张照片可以有多条，各自记作者身份，只能删自己发的
-- 运行时由 ensureAuxTables() 自动建表，这里只做文档记录
CREATE TABLE IF NOT EXISTS photo_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  author_email TEXT NOT NULL DEFAULT '',  -- Cloudflare Access 邮箱；匿名访问为空串，空串评论谁都删不掉
  author_name TEXT NOT NULL DEFAULT '',   -- 邮箱 @ 前缀，匿名显示"访客"
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photo_comments_key ON photo_comments(key);
