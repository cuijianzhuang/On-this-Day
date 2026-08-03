  // ── 实时共享房间（Durable Objects WebSocket）────────────────────────────────────
  let _room = null;           // 当前 WebSocket 连接
  let _roomKey = null;        // 当前连接的日期 key（"MM-DD"）
  let _roomReactions = {};    // {photoKey: {emoji: count}}
  let _myReactions = {};      // {photoKey: Set<emoji>} 当前用户已点过的 emoji
  let _myIdentity = null;     // 当前用户的 userId（Access 邮箱或匿名 UUID）
  let _onlineList = [];       // 当前在线用户列表（唯一 userId 数组）

  function _joinRoom(dateKey) {
    if (_room) { try { _room.close(1000); } catch (_) {} }
    _roomKey = dateKey;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/room/${dateKey}`);
    _room = ws;
    ws.onmessage = (e) => {
      try { _handleRoomMsg(JSON.parse(e.data)); } catch (_) {}
    };
    ws.onclose = () => {
      if (_roomKey === dateKey) setTimeout(() => _joinRoom(dateKey), 4000);
    };
    ws.onerror = () => {};
  }

  function _totalReactions(key) {
    const m = _roomReactions[key];
    if (!m) return 0;
    return Object.values(m).reduce((a, b) => a + b, 0);
  }

  function _handleRoomMsg(msg) {
    if (msg.type === 'init') {
      const rv2 = msg.reactions_v2 || {};
      // 兼容旧 reactions 格式 {key: count}
      const old = msg.reactions || {};
      _roomReactions = {};
      for (const [k, v] of Object.entries(rv2)) _roomReactions[k] = v;
      for (const [k, v] of Object.entries(old)) {
        if (!_roomReactions[k]) _roomReactions[k] = { '❤️': v };
      }
      _myReactions = {};
      for (const [k, arr] of Object.entries(msg.my_reactions || {})) {
        _myReactions[k] = new Set(arr);
      }
      _myIdentity = msg.you || null;
      _onlineList = msg.list || [];
      _updateBadge(msg.count, _onlineList);
      _syncAllCounts();
    } else if (msg.type === 'users') {
      _onlineList = msg.list || [];
      _updateBadge(msg.count, _onlineList);
    } else if (msg.type === 'react') {
      if (!_roomReactions[msg.key]) _roomReactions[msg.key] = {};
      _roomReactions[msg.key][msg.emoji || '❤️'] = msg.count;
      _syncCount(msg.key, _totalReactions(msg.key), true);
      // 如果灯箱当前开着且显示的就是这张照片，刷新 emoji 面板
      const lb = document.getElementById('lightbox');
      if (lb && lb.classList.contains('open')) {
        const p = allPhotos[currentIndex];
        if (p && p.key === msg.key) _renderLightboxReactions(p.key);
      }
    }
  }

  // 从 userId 派生显示名：邮箱取 @ 前缀，UUID 匿名用户显示"访"
  function _displayName(userId) {
    if (!userId) return '?';
    const at = userId.indexOf('@');
    return at > 0 ? userId.slice(0, at) : '访';
  }

  // 把 userId 字符串哈希为一个 HSL 颜色，同一人永远是同一颜色
  function _avatarColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360},55%,52%)`;
  }

  // ─────────────────────────────────────────────────────────────────────────

  function _updateBadge(count, list) {
    const badge = document.getElementById('onlineBadge');
    if (!badge) return;
    const willShow = !!(list && list.length > 0);
    badge.style.display = willShow ? '' : 'none';

    const avatarsEl = document.getElementById('onlineAvatars');
    if (avatarsEl && list) {
      avatarsEl.innerHTML = list.map(({ id, hash }) => {
        const name = _displayName(id);
        const isMe = id === _myIdentity;
        const tipLabel = id.includes('@') ? id : '访客';
        const title = isMe ? `你 · ${tipLabel}` : tipLabel;
        const initial = (name[0] || '?').toUpperCase();
        const color = _avatarColor(id);
        const cls = `online-avatar${isMe ? ' me' : ''}`;
        if (hash) {
          // 字母圆圈兜底先渲染，Gravatar 图片加载完成后淡入叠在上面（无闪烁）
          const url = `https://www.gravatar.com/avatar/${hash}?s=52&d=404&r=g`;
          return `<span class="${cls}" title="${title}">` +
            `<span class="av-letter" style="background:${color}">${initial}</span>` +
            `<img src="${url}" onload="this.classList.add('loaded')">` +
            `</span>`;
        }
        return `<span class="${cls}" title="${title}"><span class="av-letter" style="background:${color}">${initial}</span></span>`;
      }).join('');
    }

    const labelEl = document.getElementById('onlineLabel');
    if (labelEl) labelEl.textContent = count > 1 ? `${count} 人在看` : '';
  }

  function _syncAllCounts() {
    document.querySelectorAll('.react-btn[data-key]').forEach(btn => {
      const n = _totalReactions(btn.dataset.key);
      const span = btn.querySelector('.react-cnt');
      if (span) span.textContent = n > 0 ? n : '';
    });
  }

  function _syncCount(key, count, animate) {
    document.querySelectorAll(`.react-btn[data-key="${CSS.escape(key)}"]`).forEach(btn => {
      const span = btn.querySelector('.react-cnt');
      if (span) span.textContent = count > 0 ? count : '';
      if (animate) _floatHeart(btn);
    });
  }

  function _floatHeart(anchor) {
    const el = document.createElement('span');
    el.className = 'float-heart';
    el.textContent = '❤️';
    anchor.parentElement.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  window.doReact = function(btn) {
    const key = btn.dataset.key;
    if (!key) return;
    if (_room && _room.readyState === WebSocket.OPEN) {
      _room.send(JSON.stringify({ type: 'react', key, emoji: '❤️' }));
    }
    _floatHeart(btn);
  };

  window.doReactEmoji = function(key, emoji, btnEl) {
    if (!key || !emoji) return;
    if (!_myReactions[key]) _myReactions[key] = new Set();
    if (_myReactions[key].has(emoji)) {
      // 已点过 → 取消
      _myReactions[key].delete(emoji);
      if (_room && _room.readyState === WebSocket.OPEN) {
        _room.send(JSON.stringify({ type: 'unreact', key, emoji }));
      }
      if (_roomReactions[key]) {
        _roomReactions[key][emoji] = Math.max(0, (_roomReactions[key][emoji] || 0) - 1);
      }
    } else {
      // 未点过 → 添加
      _myReactions[key].add(emoji);
      if (_room && _room.readyState === WebSocket.OPEN) {
        _room.send(JSON.stringify({ type: 'react', key, emoji }));
      }
      if (!_roomReactions[key]) _roomReactions[key] = {};
      _roomReactions[key][emoji] = (_roomReactions[key][emoji] || 0) + 1;
      const el = btnEl || document.querySelector(`#lbEmojiPopup .lp-emoji-btn[data-emoji="${CSS.escape(emoji)}"]`);
      if (el) { el.classList.remove('pop'); requestAnimationFrame(() => el.classList.add('pop')); }
    }
    _syncCount(key, _totalReactions(key), false);
    _renderLightboxReactions(key);
  };
  // ────────────────────────────────────────────────────────────────────────────────

  // ── 禁止页面缩放 ──────────────────────────────────────────────────────────────
  // iOS Safari 10+ 忽略 viewport user-scalable=no，需要 JS 多层拦截。
  // lightbox 内允许捏合查看图片细节，其余区域全部阻断。
  function isInLightbox(el) { return el && el.closest && !!el.closest('.lightbox'); }

  // 层 1：touchstart 多指——在手势识别之前最早拦截，避免 gesturestart 的微小延迟
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length > 1 && !isInLightbox(e.target)) e.preventDefault();
  }, { passive: false });

  // 层 2：gesturestart——Safari 私有事件，双保险
  document.addEventListener('gesturestart', (e) => {
    if (!isInLightbox(e.target)) e.preventDefault();
  }, { passive: false });

  // 层 3：touchmove 多指——覆盖 Chrome/Firefox（不支持 gesture* 事件）
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 && !isInLightbox(e.target)) e.preventDefault();
  }, { passive: false });

  // 横向偏移归零：body{overflow-x:hidden} 只挡 body 层，html 层仍可横向偏移；
  // 任何时候 scrollX != 0 立即归零，防止 zoom/pan 后页面"不居中"且无法自动恢复
  function _resetScrollX() {
    if (window.scrollX !== 0) window.scrollTo({ left: 0, top: window.scrollY, behavior: 'instant' });
  }
  window.addEventListener('scroll', _resetScrollX, { passive: true });

  // 层 4：visualViewport 自动恢复——万一以上三层都被绕过，检测到 scale>1 立即强制归零
  // minimum-scale=1 + maximum-scale=1 会让 iOS Safari 立刻 snap 回 scale 1
  if (window.visualViewport) {
    const _vpRecover = () => {
      const vp = window.visualViewport;
      if (vp.scale > 1.05 || vp.offsetLeft !== 0) {
        const m = document.querySelector('meta[name="viewport"]');
        if (m) m.content = 'width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover';
        _resetScrollX();
      }
    };
    window.visualViewport.addEventListener('resize', _vpRecover);
    window.visualViewport.addEventListener('scroll', _vpRecover);
  }
  // ─────────────────────────────────────────────────────────────────────────────

  // 拼 HTML 字符串时用来转义属性值，避免文件名/路径里万一带了引号之类的字符把属性或内嵌脚本弄断
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
  function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _formatFileSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
  }
  function _formatExifDate(dt) {
    if (!dt) return '';
    // "YYYY:MM:DD HH:MM:SS" → "YYYY/MM/DD HH:MM"
    return dt.slice(0, 10).replace(/:/g, '/') + ' ' + dt.slice(11, 16);
  }

  // SVG icon paths for lightbox panel labels
  const LP_ICONS = {
    '文件名':  '<path d="M6 2H14L18 6V20a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2zm0 0v4h4"/>',
    '年份':    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    '地点':    '<path d="M12 2C8.134 2 5 5.134 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.866-3.134-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z"/>',
    '文件大小':'<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    '分辨率':  '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
    '像素':    '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>',
    '拍摄时间':'<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    '时区':    '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>',
    '色彩空间':'<circle cx="12" cy="12" r="10"/><circle cx="8.5" cy="11" r="2.5" fill="none"/><circle cx="15.5" cy="11" r="2.5" fill="none"/><circle cx="12" cy="16" r="2.5" fill="none"/>',
    '纬度':    '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
    '经度':    '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>',
    '海拔':    '<polyline points="23 6 13 16 8 11 1 18"/><polyline points="17 6 23 6 23 12"/>',
    '软件':    '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    '焦距':    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
    '光圈':    '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    '曝光时间':'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'ISO':     '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    '亮度':    '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
    '感光方式':'<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    '相机':    '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>',
    '最大光圈':'<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    '35mm 等效':'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',
    '镜头':    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    '白平衡':  '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>',
    '曝光程序':'<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
    '曝光模式':'<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><line x1="8" y1="2" x2="8" y2="18"/>',
    '测光模式':'<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="12" x2="16" y2="14"/>',
    '闪光灯':  '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    '场景捕捉':'<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/>',
  };

  function _lpIcon(label) {
    const path = LP_ICONS[label];
    if (!path) return '';
    return `<svg class="lp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }

  function _lpRow(label, value, cls) {
    const icon = _lpIcon(label);
    const valCls = cls ? ` ${cls}` : '';
    return `<div class="lp-row"><span class="lp-label">${icon}${escHtml(label)}</span><span class="lp-value${valCls}">${escHtml(String(value))}</span></div>`;
  }

  function _lpSec(title, rows) {
    return `<div class="lp-section-title">${escHtml(title)}</div><div class="lp-info-table">${rows.map(([l,v,cls]) => _lpRow(l,v,cls)).join('')}</div>`;
  }

  // 缩略图第一次加载失败，先按 5s/15s/45s 退避重试原来的 /thumb/ 链接几次（破一下缓存强制重新请求）——
  // 很多裂图只是服务端转码/边缘缓存这会儿还没跟上，过一会儿自己就好了，不用等用户手动刷新整页。
  // 重试次数用完还是不行，才真正走 heicFallback 的现场解码/原图兜底
  const IMAGE_RETRY_DELAYS = [5000, 15000, 45000];
  window.scheduleImageRetry = function (imgEl, thumbSrc, originalUrl, attempt) {
    attempt = attempt || 0;
    if (attempt >= IMAGE_RETRY_DELAYS.length) {
      heicFallback(imgEl, originalUrl);
      return;
    }
    setTimeout(() => {
      if (!document.body.contains(imgEl)) return; // 这张图已经不在页面上了（比如切了日期），别再瞎重试
      imgEl.onerror = () => scheduleImageRetry(imgEl, thumbSrc, originalUrl, attempt + 1);
      imgEl.src = thumbSrc + (thumbSrc.indexOf('?') >= 0 ? '&' : '?') + '_retry=' + Date.now();
    }, IMAGE_RETRY_DELAYS[attempt]);
  };

  // 缩放失败时的兜底：非 HEIC 文件直接换成原图（浏览器本来就能显示），
  // 只有 HEIC 才需要在浏览器里用 heic2any 现场解码，不依赖任何服务端转码。
  // 注意：'loaded' 必须等新图真的加载完才能加，不能加完 src 就立刻标记完成——
  // 不然图片数据还没到，opacity 先变成 1，看到的就是浏览器原生的"裂图"占位图标
  // heic2any 偶尔会因为浏览器一时半会的内存/资源紧张失败（不是文件真解不开），重试几次再放弃；
  // 重试间隔故意拉开（1.5s/4s），别让标签页在很短时间里反复占满内存做无意义的重试
  const HEIC_DECODE_RETRY_DELAYS = [1500, 4000];

  // heic2any 有 1.3MB，而且只在"服务端转码没跑到、缩略图加载失败"这条兜底路径上才用得到——
  // 绝大多数访问根本走不到这里。所以不在页面加载时引入，第一次真的需要时才动态注入 script，
  // 并且所有并发调用共享同一个加载 Promise；加载失败（弱网）时清掉缓存的 Promise，下次调用重新试
  let _heicLibPromise = null;
  function loadHeicLib() {
    if (window.heic2any) return Promise.resolve();
    if (!_heicLibPromise) {
      _heicLibPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/heic2any.min.js';
        s.onload = resolve;
        s.onerror = () => { _heicLibPromise = null; s.remove(); reject(new Error('heic2any load failed')); };
        document.head.appendChild(s);
      });
    }
    return _heicLibPromise;
  }

  window.heicFallback = async function (imgEl, originalUrl, attempt) {
    attempt = attempt || 0;
    if (!/\.heic$/i.test(originalUrl)) {
      imgEl.onload = () => imgEl.classList.add('loaded');
      imgEl.src = originalUrl;
      return;
    }
    try {
      const [, resp] = await Promise.all([loadHeicLib(), fetch(originalUrl)]);
      const blob = await resp.blob();
      const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.85 });
      const previewBlob = Array.isArray(converted) ? converted[0] : converted;
      const objUrl = URL.createObjectURL(previewBlob);
      imgEl.onload = () => imgEl.classList.add('loaded');
      imgEl.src = objUrl;
      // 顺手把现场解码的结果回传存进 PREVIEWS 桶，下次别的访问者就不用再解码一遍了——
      // 哪怕服务端那边重试次数早就用完放弃了，这次浏览器端解码成功一样会被接受存进去
      const heicKey = originalUrl.replace('/img/', '');
      fetch('/api/upload-heic-preview?key=' + heicKey, { method: 'POST', body: previewBlob }).catch(() => {});
    } catch {
      if (attempt < HEIC_DECODE_RETRY_DELAYS.length) {
        setTimeout(() => {
          if (document.body.contains(imgEl)) heicFallback(imgEl, originalUrl, attempt + 1);
        }, HEIC_DECODE_RETRY_DELAYS[attempt]);
        return;
      }
      // 重试次数用完还是解不出来，才真正放弃，至少别让它一直卡在 opacity:0 看起来像黑框；
      // 多加个 give-up 标记——没有真图片撑不出原图比例，靠这个让方形占位比例继续生效，
      // 不然 frame-inner 会被 :has(.loaded) 那条规则放行成 auto，没尺寸的裂图直接塌成一条薄片
      imgEl.classList.add('loaded', 'give-up');
    }
  };

  // 长按实况照片要触发播放而不是系统菜单：iOS 的"保存/复制"菜单由
  // -webkit-touch-callout:none 拦（见 CSS），Android Chrome 的 contextmenu 在这里拦
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest && e.target.closest('.live-photo-cell, .live-photo-wrap')) e.preventDefault();
  });

  window.livePhotoTouchStart = function(el, e) {
    if (e.touches.length > 1) return; // ignore pinch
    el._lpTimer = setTimeout(() => {
      el._lpPlaying = true;
      el.classList.add('playing');
      const v = el.querySelector('video');
      v.currentTime = 0;
      v.play().catch(() => {});
      if (navigator.vibrate) navigator.vibrate(10);
    }, 350);
  };
  window.livePhotoTouchEnd = function(el, e) {
    clearTimeout(el._lpTimer);
    if (el._lpPlaying) {
      el._lpPlaying = false;
      el.classList.remove('playing');
      el.querySelector('video').pause();
      e.preventDefault(); // suppress click→lightbox after long-press
    }
  };

  // 今日诗词：跟翻看哪个历史日期无关，配的是"今天"这句——挂个第三方接口失败/204 都不影响主功能
  fetch('/api/poem').then(r => r.status === 204 ? null : r.json()).then(poem => {
    if (!poem) return;
    const el = document.getElementById('dailyPoem');
    // 用 textContent/DOM API 拼，不用 innerHTML——内容来自第三方接口，不放心直接当 HTML 插进去
    el.textContent = '「' + poem.content + '」';
    const source = document.createElement('span');
    source.className = 'poem-source';
    source.textContent = '—— ' + poem.dynasty + '·' + poem.author + '《' + poem.title + '》';
    el.appendChild(source);
    el.classList.add('show');
  }).catch(() => {});

  // 纪念日提醒：跟今日诗词一样，只看真实"今天"，跟浏览哪个历史日期无关。
  // data.date 是后端算出的北京日期（YYYY-MM-DD），关闭 banner 时存这个 key 而不是浏览器本地
  // 日期——避免跨时区/跨零点的边界上，"今天"两边算得不一样导致关闭状态失效或误伤明天
  const ANNIV_DISMISS_KEY = 'annivBannerDismissedDate';
  fetch('/api/anniversaries/upcoming').then(r => r.ok ? r.json() : null).then(data => {
    if (!data) return;
    const banner = document.getElementById('annivBanner');
    if (!banner) return;
    if (data.date && localStorage.getItem(ANNIV_DISMISS_KEY) === data.date) return;
    const items = [];
    for (const a of (data.today || [])) {
      items.push('🎉 ' + (a.lunar ? '🌙 ' : '') + '今天是「' + a.title + '」' + (a.nth ? '（第 ' + a.nth + ' 年）' : ''));
    }
    for (const a of (data.upcoming || [])) {
      items.push('📅 ' + (a.lunar ? '🌙 ' : '') + '还有 ' + a.daysLeft + ' 天是「' + a.title + '」');
    }
    if (!items.length) return;
    banner.textContent = '';
    items.forEach(text => {
      const span = document.createElement('span');
      span.className = 'anniv-item';
      span.textContent = text; // 内容来自数据库自建条目，非第三方，但仍用 textContent 保持一致习惯
      banner.appendChild(span);
    });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'anniv-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭提醒');
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => {
      banner.hidden = true;
      if (data.date) { try { localStorage.setItem(ANNIV_DISMISS_KEY, data.date); } catch {} }
    };
    banner.appendChild(closeBtn);
    banner.hidden = false;
  }).catch(() => {});

  // 历史上的今天（Wikimedia）：跟着正在浏览的日期走，loadMemories 每次切日期都会重新拉。
  // 折叠态是单条轮播（每 8 秒淡入淡出换一条大事记），点开是完整列表（展开时暂停轮播，
  // 展开状态跨日期保持）。接口 204/失败就整块隐藏；第三方内容只用 textContent 渲染
  let _otdSeq = 0, _otdEvents = [], _otdIdx = 0, _otdTimer = null;
  function _otdShowTick(animate) {
    const el = document.getElementById('otdTicker');
    if (!el || !_otdEvents.length) return;
    const ev = _otdEvents[_otdIdx % _otdEvents.length];
    const set = () => { el.textContent = '🕰 ' + ev.year + '年 · ' + ev.text; };
    if (animate) {
      el.classList.add('otd-fading');
      setTimeout(() => { set(); el.classList.remove('otd-fading'); }, 250);
    } else {
      set();
    }
  }
  function _otdStartTicker() {
    clearInterval(_otdTimer);
    if (_otdEvents.length < 2) return;
    _otdTimer = setInterval(() => {
      const list = document.getElementById('otdList');
      if (!list || !list.hidden) return; // 展开时暂停轮播
      _otdIdx = (_otdIdx + 1) % _otdEvents.length;
      _otdShowTick(true);
    }, 8000);
  }
  function loadOnThisDay(m, d) {
    const seq = ++_otdSeq;
    const block = document.getElementById('otdBlock');
    const list = document.getElementById('otdList');
    if (!block || !list) return;
    fetch('/api/onthisday?month=' + m + '&day=' + d)
      .then(r => (r.ok && r.status !== 204) ? r.json() : null)
      .then(data => {
        if (seq !== _otdSeq) return; // 已切到别的日期，丢弃过期结果
        if (!data || !Array.isArray(data.events) || !data.events.length) {
          block.hidden = true;
          clearInterval(_otdTimer);
          _otdEvents = [];
          return;
        }
        _otdEvents = data.events;
        _otdIdx = 0;
        list.textContent = '';
        for (const ev of data.events) {
          const row = document.createElement('div');
          row.className = 'otd-item';
          const y = document.createElement('span');
          y.className = 'otd-year';
          y.textContent = ev.year + '年';
          row.appendChild(y);
          row.appendChild(document.createTextNode(String(ev.text)));
          list.appendChild(row);
        }
        block.hidden = false;
        // 展开状态跨日期保持：展开时按钮显示固定标题，收起时恢复单条轮播
        if (list.hidden) _otdShowTick(false);
        else document.getElementById('otdTicker').textContent = '🕰 历史上的今天';
        _otdStartTicker();
      })
      .catch(() => { if (seq === _otdSeq) block.hidden = true; });
  }
  document.getElementById('otdToggle').addEventListener('click', () => {
    const list = document.getElementById('otdList');
    const open = list.hidden; // 本次点击是要展开吗
    list.hidden = !open;
    document.getElementById('otdToggle').classList.toggle('open', open);
    if (open) document.getElementById('otdTicker').textContent = '🕰 历史上的今天';
    else _otdShowTick(false);
  });

  const params = new URLSearchParams(location.search);
  const now = new Date();
  // 改成 let——切日期不再整页刷新，这两个变量要跟着原地更新（地图链接、日历高亮都靠它们）
  let month = params.get('month') || String(now.getMonth() + 1).padStart(2, '0');
  let day = params.get('day') || String(now.getDate()).padStart(2, '0');

  // 地图图标带上当前正在看的日期，这样从某个历史日期点进地图，看到的也是那一天的照片
  document.getElementById('mapLink').href = '/map?month=' + month + '&day=' + day;

  const lunarToggle = document.getElementById('lunarToggle');
  let calendarMode = localStorage.getItem('calendarMode') || (localStorage.getItem('showLunarMemories') === '1' ? 'lunar' : 'solar');
  function syncLunarToggle() {
    if (!lunarToggle) return;
    const isLunarMode = calendarMode === 'lunar';
    lunarToggle.classList.toggle('active', isLunarMode);
    lunarToggle.setAttribute('aria-pressed', isLunarMode ? 'true' : 'false');
    lunarToggle.title = isLunarMode ? '当前农历，点击切到公历' : '当前公历，点击切到农历';
  }
  function removeLunarMemoriesFromDom() {
    document.querySelectorAll('.lunar-divider, .year-block.lunar-year-block').forEach((el) => el.remove());
  }
  syncLunarToggle();
  if (lunarToggle) {
    lunarToggle.onclick = () => {
      calendarMode = calendarMode === 'lunar' ? 'solar' : 'lunar';
      localStorage.setItem('calendarMode', calendarMode);
      localStorage.setItem('showLunarMemories', calendarMode === 'lunar' ? '1' : '0');
      syncLunarToggle();
      // 关闭时先把已经渲染出来的农历段落立即移除，避免等待接口期间看起来像开关没生效。
      if (calendarMode !== 'lunar') removeLunarMemoriesFromDom();
      loadMemories(month, day);
    };
  }

  // 自制日历：点小日历图标展开，选好日期跳转到 ?month=&day=
  // 不用原生 <input type="date">，因为浏览器自带的日历弹层样式没法跟这套深色 UI 统一
  const dateToggle = document.getElementById('dateToggle');
  const datePicker = document.getElementById('datePicker');
  const calMonthLabel = document.getElementById('calMonthLabel');
  const calGrid = document.getElementById('calGrid');
  const calPrevMonth = document.getElementById('calPrevMonth');
  const calNextMonth = document.getElementById('calNextMonth');

  let calViewYear = now.getFullYear();
  let calViewMonth = Number(month) - 1; // 0-based
  let currentMonth = Number(month);
  let currentDay = Number(day);

  function renderCalendar() {
    calMonthLabel.textContent = calViewYear + '年' + String(calViewMonth + 1).padStart(2, '0') + '月';
    const firstWeekday = (new Date(calViewYear, calViewMonth, 1).getDay() + 6) % 7; // 周一为第一列
    const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
    const isCurrentRealMonth = calViewYear === now.getFullYear() && calViewMonth === now.getMonth();
    const isViewingSelectedMonth = calViewMonth + 1 === currentMonth;

    let html = '';
    for (let i = 0; i < firstWeekday; i++) html += '<button disabled></button>';
    for (let d = 1; d <= daysInMonth; d++) {
      const classes = [];
      if (isCurrentRealMonth && d === now.getDate()) classes.push('today');
      if (isViewingSelectedMonth && d === currentDay) classes.push('selected');
      html += '<button class="' + classes.join(' ') + '" data-day="' + d + '">' + d + '</button>';
    }
    calGrid.innerHTML = html;
    // 点哪天就直接加载，不用再多点一次"查看"——少一步，也不会让人觉得"点了没反应"。
    // 原来这里是 location.href 整页刷新，切一次日期等于把页面所有初始化（自定义指针、指尖联动、
    // 环境音、IntersectionObserver……）全部重新跑一遍，体感上的"卡顿"很大一部分就是这个整页刷新本身，
    // 不是渲染逻辑慢。改成 history.pushState + 原地重新拉数据，URL 照样会变、能收藏/分享，但不刷新整页
    calGrid.querySelectorAll('button[data-day]').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const m = String(calViewMonth + 1).padStart(2, '0');
        const d = String(btn.dataset.day).padStart(2, '0');
        navigateToDate(m, d);
        datePicker.classList.remove('open');
      };
    });
  }
  renderCalendar();

  // 切日期统一走这个函数：更新 URL（pushState，不刷新整页）、地图链接、日历高亮状态，再原地重新加载数据
  function navigateToDate(m, d) {
    month = m; day = d;
    currentMonth = Number(m); currentDay = Number(d);
    history.pushState(null, '', location.pathname + '?month=' + m + '&day=' + d);
    document.getElementById('mapLink').href = '/map?month=' + m + '&day=' + d;
    renderCalendar();
    loadMemories(m, d);
  }
  // 浏览器前进/后退也要认这个 URL，不然退回去地址栏变了但页面内容没跟着变
  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search);
    const nowD = new Date();
    month = p.get('month') || String(nowD.getMonth() + 1).padStart(2, '0');
    day = p.get('day') || String(nowD.getDate()).padStart(2, '0');
    currentMonth = Number(month); currentDay = Number(day);
    document.getElementById('mapLink').href = '/map?month=' + month + '&day=' + day;
    renderCalendar();
    loadMemories(month, day);
  });

  calPrevMonth.onclick = (e) => {
    e.stopPropagation();
    calViewMonth -= 1;
    if (calViewMonth < 0) { calViewMonth = 11; calViewYear -= 1; }
    renderCalendar();
  };
  calNextMonth.onclick = (e) => {
    e.stopPropagation();
    calViewMonth += 1;
    if (calViewMonth > 11) { calViewMonth = 0; calViewYear += 1; }
    renderCalendar();
  };

  // 头部这几个下拉（日期/年份/更多功能/搜索）共享同一小块屏幕区域，各自独立 toggle 的话
  // 一次能同时开好几个，彼此叠在一起完全遮挡——所以开任意一个之前，先把其余全关掉，
  // 同一时刻只允许一个下拉展开。closeAllHeaderMenus 引用的几个 const 会在下面陆续声明，
  // 但这个函数只在点击时才真正执行，那时候全部已经初始化完毕，不受声明顺序影响
  function closeAllHeaderMenus(except) {
    if (datePicker !== except) datePicker.classList.remove('open');
    if (yearMenu !== except) yearMenu.classList.remove('open');
    if (navMenu !== except) navMenu.classList.remove('open');
    if (searchPanel !== except) searchPanel.classList.remove('open');
  }

  dateToggle.onclick = (e) => {
    e.stopPropagation();
    const willOpen = !datePicker.classList.contains('open');
    closeAllHeaderMenus();
    if (willOpen) datePicker.classList.add('open');
  };

  // "跳到某一年"下拉菜单
  const yearToggle = document.getElementById('yearToggle');
  const yearMenu = document.getElementById('yearMenu');
  yearToggle.onclick = (e) => {
    e.stopPropagation();
    const willOpen = !yearMenu.classList.contains('open');
    closeAllHeaderMenus();
    if (willOpen) yearMenu.classList.add('open');
  };

  // "更多功能"下拉：年度回忆/全家最爱/足迹地图/数据总览/运维控制台入口
  const navMenuToggle = document.getElementById('navMenuToggle');
  const navMenu = document.getElementById('navMenu');
  navMenuToggle.onclick = (e) => {
    e.stopPropagation();
    const willOpen = !navMenu.classList.contains('open');
    closeAllHeaderMenus();
    if (willOpen) navMenu.classList.add('open');
  };

  // 照片搜索：搜 AI 说明文字和拍摄地名，防抖 350ms，回车立即搜
  const searchToggle = document.getElementById('searchToggle');
  const searchPanel = document.getElementById('searchPanel');
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  let _searchTimer = null, _searchSeq = 0;

  searchToggle.onclick = (e) => {
    e.stopPropagation();
    const willOpen = !searchPanel.classList.contains('open');
    closeAllHeaderMenus();
    if (willOpen) {
      searchPanel.classList.add('open');
      setTimeout(() => searchInput.focus(), 60);
    }
  };

  function runSearch() {
    const q = searchInput.value.trim();
    if (!q) { searchResults.innerHTML = ''; return; }
    const seq = ++_searchSeq;
    searchResults.innerHTML = '<div class="search-hint">搜索中…</div>';
    fetch('/api/search?q=' + encodeURIComponent(q))
      .then(r => r.ok ? r.json() : { photos: [] })
      .then(data => {
        if (seq !== _searchSeq) return; // 已被更新的输入顶替
        const photos = data.photos || [];
        if (!photos.length) {
          searchResults.innerHTML = '<div class="search-hint">没有找到「' + escHtml(q) + '」相关的照片</div>';
          return;
        }
        searchResults.innerHTML = photos.map(p => {
          const thumb = p.url.replace('/img/', '/thumb/') + '?w=96&h=96&q=70&fit=cover';
          const title = p.caption || p.key.split('/').pop();
          const tagsText = (p.tags && p.tags.length) ? p.tags.join(' ') : '';
          const meta = [p.place, tagsText, p.year + '/' + p.month + '/' + p.day].filter(Boolean).join(' · ');
          return '<a class="search-row" href="/?month=' + p.month + '&day=' + p.day + '">' +
            '<img src="' + escAttr(thumb) + '" loading="lazy" />' +
            '<span class="sr-text"><span class="sr-title">' + escHtml(title) + '</span>' +
            '<span class="sr-meta">' + escHtml(meta) + '</span></span></a>';
        }).join('');
      })
      .catch(() => {
        if (seq === _searchSeq) searchResults.innerHTML = '<div class="search-hint">搜索失败，请稍后再试</div>';
      });
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(runSearch, 350);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(_searchTimer); runSearch(); }
    if (e.key === 'Escape') searchPanel.classList.remove('open');
  });

  document.addEventListener('click', (e) => {
    if (datePicker.classList.contains('open') && !datePicker.contains(e.target) && e.target !== dateToggle && !dateToggle.contains(e.target)) {
      datePicker.classList.remove('open');
    }
    if (yearMenu.classList.contains('open') && !yearMenu.contains(e.target) && e.target !== yearToggle && !yearToggle.contains(e.target)) {
      yearMenu.classList.remove('open');
    }
    if (navMenu.classList.contains('open') && !navMenu.contains(e.target) && e.target !== navMenuToggle && !navMenuToggle.contains(e.target)) {
      navMenu.classList.remove('open');
    }
    if (searchPanel.classList.contains('open') && !searchPanel.contains(e.target) && e.target !== searchToggle && !searchToggle.contains(e.target)) {
      searchPanel.classList.remove('open');
    }
  });

  // "唤醒林间"开关：一个开关同时控制光斑视觉效果和林间环境音，默认开启
  // 浏览器禁止自动带声音播放，所以默认开启时光斑视觉照常显示，但声音要等用户第一次交互后才能真正响起
  const sunlight = document.querySelector('.sunlight');
  const sunSweep = document.getElementById('sunSweep');
  const ambientAudio = document.getElementById('ambientAudio');
  const sunlightSwitch = document.getElementById('sunlightSwitch');
  const sunlightLabel = document.getElementById('sunlightLabel');
  sunlightSwitch.checked = true;
  sunlightLabel.textContent = 'KEEP THE SUN OUT';
  document.body.classList.add('sun-on');
  sunlight.classList.add('on');
  ambientAudio.volume = 0.5;
  ambientAudio.play().catch(() => {});

  // 背景叶影视频：iOS 低电量模式禁止 autoplay 且会画系统 ▶ 按钮。播放失败就把视频藏掉
  // （光斑 glow 层照常，氛围不塌），等用户第一次触摸/点击（此时允许播放了）再恢复。
  // src 不在 HTML 里直接给——整段 mp4 会跟首屏缩略图抢带宽，等首屏数据到了（见 loadMemories）
  // 或用户先交互了再挂上开始加载，氛围层晚一两秒出现无感知，照片墙快很多
  const leafVideo = document.getElementById('leafVideo');
  let startLeafVideo = () => {};
  if (leafVideo) {
    const tryPlayLeaf = () => {
      if (!leafVideo.src) leafVideo.src = leafVideo.dataset.src;
      leafVideo.play().then(() => { leafVideo.style.display = ''; }).catch(() => { leafVideo.style.display = 'none'; });
    };
    startLeafVideo = tryPlayLeaf;
    window.addEventListener('touchend', tryPlayLeaf, { once: true, passive: true });
    window.addEventListener('click', tryPlayLeaf, { once: true });
  }
  sunlightSwitch.onchange = () => {
    document.body.classList.toggle('sun-on', sunlightSwitch.checked);
    sunlight.classList.toggle('on', sunlightSwitch.checked);
    sunlightLabel.textContent = sunlightSwitch.checked ? 'KEEP THE SUN OUT' : 'LET THE SUN IN';
    if (sunlightSwitch.checked) {
      sunSweep.classList.remove('play');
      requestAnimationFrame(() => sunSweep.classList.add('play'));
      ambientAudio.volume = 0.5;
      ambientAudio.play().catch(() => {});
    } else {
      ambientAudio.pause();
    }
  };

  const lightbox = document.getElementById('lightbox');
  const lightboxBody = document.getElementById('lightboxBody');
  const lightboxDownload = document.getElementById('lightboxDownload');
  const lightboxShare = document.getElementById('lightboxShare');
  const toast = document.getElementById('toast');

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  // 回到顶部：滚得够远才出现，避免一开始就挡在右下角
  const backToTop = document.getElementById('backToTop');
  window.addEventListener('scroll', () => {
    backToTop.classList.toggle('show', window.scrollY > window.innerHeight * 0.6);
  }, { passive: true });
  backToTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  let allPhotos = [];   // 扁平化的全部照片，按年份顺序
  let currentIndex = -1;
  let slideTimer = null;
  let autoPlaying = false;
  const EFFECTS = ['fx-fade', 'fx-zoom', 'fx-left', 'fx-right'];
  let lastEffect = -1;

  function pickEffect() {
    let i = Math.floor(Math.random() * EFFECTS.length);
    if (i === lastEffect) i = (i + 1) % EFFECTS.length;
    lastEffect = i;
    return EFFECTS[i];
  }

  const EMOJI_LIST = ['👍','❤️','😍','😂','😮','😢','🔥','✨'];

  function _renderHistogram(canvas) {
    const img = lightboxBody.querySelector('img');
    if (!img) return;
    function draw() {
      try {
        const SIZE = 200;
        const oc = document.createElement('canvas');
        const sc = Math.min(SIZE / img.naturalWidth, SIZE / img.naturalHeight, 1);
        oc.width = Math.max(1, Math.round(img.naturalWidth * sc));
        oc.height = Math.max(1, Math.round(img.naturalHeight * sc));
        const cx2 = oc.getContext('2d', { willReadFrequently: true });
        cx2.drawImage(img, 0, 0, oc.width, oc.height);
        const px = cx2.getImageData(0, 0, oc.width, oc.height).data;
        const r = new Float32Array(256), g = new Float32Array(256), b = new Float32Array(256);
        for (let i = 0; i < px.length; i += 4) { r[px[i]]++; g[px[i+1]]++; b[px[i+2]]++; }
        let maxV = 0;
        for (let i = 0; i < 256; i++) maxV = Math.max(maxV, r[i], g[i], b[i]);
        if (!maxV) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        function ch(counts, color) {
          ctx.beginPath();
          ctx.moveTo(0, H);
          for (let i = 0; i <= 255; i++) {
            const x = (i / 255) * W, y = H - (counts[i] / maxV) * H;
            i === 0 ? ctx.lineTo(x, H) : ctx.lineTo(x, y);
          }
          ctx.lineTo(W, H);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
        }
        ch(r, 'rgba(235,60,60,0.6)');
        ch(g, 'rgba(50,185,50,0.55)');
        ch(b, 'rgba(60,100,235,0.6)');
      } catch (_) { canvas.style.display = 'none'; }
    }
    if (img.complete && img.naturalWidth > 0) draw();
    else img.addEventListener('load', draw, { once: true });
  }

  function _renderLightboxReactions(key) {
    const counts = _roomReactions[key] || {};
    const mine = _myReactions[key] || new Set();
    // data-key / data-emoji 避免把 JSON.stringify 的双引号嵌进 HTML 属性里（会截断属性值导致 SyntaxError）
    const gridHtml = '<div class="lp-emoji-grid" data-rkey="' + escAttr(key) + '">' + EMOJI_LIST.map(e => {
      const n = counts[e] || 0;
      const cls = mine.has(e) ? ' reacted' : '';
      return `<button class="lp-emoji-btn${cls}" data-emoji="${escAttr(e)}">${e}<span class="lp-emoji-cnt">${n > 0 ? n : ''}</span></button>`;
    }).join('') + '</div>';
    const popup = document.getElementById('lbEmojiPopup');
    if (popup) popup.innerHTML = gridHtml;
    const countEl = document.getElementById('lbReactCount');
    if (countEl) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      countEl.textContent = total > 0 ? total + ' 个表态' : '';
    }
  }

  // 用事件委托代替每个按钮的 inline onclick——可以安全处理任意键值/emoji
  lightbox.addEventListener('click', (e) => {
    const btn = e.target.closest('.lp-emoji-btn');
    if (!btn) return;
    const grid = btn.closest('[data-rkey]');
    const key  = grid ? grid.dataset.rkey : null;
    const emoji = btn.dataset.emoji;
    if (key && emoji) doReactEmoji(key, emoji, btn);
  });

  // 表态浮动按钮：点击展开/收起 emoji 弹窗
  const lbReactBtn = document.getElementById('lbReactBtn');
  const lbEmojiPopup = document.getElementById('lbEmojiPopup');
  if (lbReactBtn && lbEmojiPopup) {
    lbReactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      lbEmojiPopup.classList.toggle('open');
    });
    lightbox.addEventListener('click', (e) => {
      if (!e.target.closest('#lbEmojiPopup') && !e.target.closest('#lbReactBtn')) {
        lbEmojiPopup.classList.remove('open');
      }
    });
  }

  function _renderLightboxInfo(p) {
    const filenameEl = document.getElementById('lpFilename');
    if (filenameEl) {
      const name = p.key.split('/').pop().replace(/\.[^.]+$/, '');
      const tagsHtml = (p.tags && p.tags.length)
        ? '<div class="lp-tags">' + p.tags.map(t => '<span class="lp-tag">' + escHtml(t) + '</span>').join('') + '</div>'
        : '';
      filenameEl.innerHTML =
        `<div class="lp-photo-title">${escHtml(name)}</div>` +
        (p.caption ? `<div class="lp-photo-caption">${escHtml(p.caption)}</div>` : '') +
        tagsHtml;
    }

    const infoEl = document.getElementById('lpInfo');
    if (!infoEl) return;
    const filename = p.key.split('/').pop();
    const rows = [
      _lpRow('文件名', filename, 'lp-mono lp-small'),
      _lpRow('年份', p.year + ' 年'),
    ];
    if (p.place) rows.push(_lpRow('地点', p.place));
    infoEl.innerHTML =
      '<div id="lpMapPlaceholder"></div>' +
      '<div class="lp-section-title">基本信息</div>' +
      '<div class="lp-info-table" id="lpBasicTable">' + rows.join('') + '</div>' +
      '<div class="lp-section-title">手记</div>' +
      '<div class="lp-note-wrap" id="lpNoteWrap"><div class="lp-note-empty">加载中…</div></div>';
    _loadNote(p.key);
  }

  // ── 照片手记：多人评论串，家人各自留言，存服务端全家可见，只能删自己发的 ─────
  let _noteSeq = 0;
  function _loadNote(key) {
    const seq = ++_noteSeq;
    fetch('/api/note?key=' + encodeURIComponent(key))
      .then(r => r.ok ? r.json() : { comments: [] })
      .then(d => { if (seq === _noteSeq) _renderComments(key, d.comments || []); })
      .catch(() => { if (seq === _noteSeq) _renderComments(key, []); });
  }

  // 简单相对时间：分钟内"刚刚"，24 小时内"N 小时前"，再远给具体日期
  function _commentTime(iso) {
    const diff = Date.now() - Date.parse(iso);
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return iso.slice(0, 10).replace(/-/g, '/');
  }

  function _renderComments(key, comments) {
    const wrap = document.getElementById('lpNoteWrap');
    if (wrap) {
      const listHtml = comments.length
        ? comments.map(c =>
            '<div class="lp-comment">' +
              '<div class="lp-comment-head"><span class="lp-comment-author">' + escHtml(c.author) + '</span>' +
              '<span class="lp-comment-time">' + _commentTime(c.createdAt) + '</span></div>' +
              '<div class="lp-comment-text">' + escHtml(c.note) + '</div>' +
              (c.mine ? '<button class="lp-comment-del" type="button" data-id="' + c.id + '">删除</button>' : '') +
            '</div>'
          ).join('')
        : '<div class="lp-note-empty">还没有人留言</div>';
      wrap.innerHTML =
        '<div class="lp-comment-list">' + listHtml + '</div>' +
        '<div class="lp-comment-compose">' +
          '<textarea class="lp-note-input" maxlength="500" rows="2" placeholder="说点什么…"></textarea>' +
          '<button class="lp-note-save" type="button">发送</button>' +
        '</div>';
      wrap.querySelectorAll('.lp-comment-del').forEach(btn => {
        btn.onclick = () => _deleteComment(key, Number(btn.dataset.id));
      });
      const ta = wrap.querySelector('textarea');
      wrap.querySelector('.lp-note-save').onclick = () => _postComment(key, ta);
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) _postComment(key, ta);
      });
    }
    // 移动端信息面板是隐藏的，最新一条留言显示在底部提示区
    const hint = document.getElementById('lbZoomHint');
    if (hint && window.innerWidth <= 640) {
      hint.textContent = comments.length ? '📝 ' + comments[comments.length - 1].note : '';
    }
  }

  function _postComment(key, ta) {
    const note = ta.value.trim();
    if (!note) return;
    ta.disabled = true;
    fetch('/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, note }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed'); return r.json(); })
      .then(() => { showToast('已发送'); _loadNote(key); })
      .catch(() => { showToast('发送失败，请重试'); ta.disabled = false; });
  }

  function _deleteComment(key, id) {
    fetch('/api/note', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, id }),
    })
      .then(r => { if (!r.ok) throw new Error('delete failed'); return r.json(); })
      .then(() => { showToast('已删除'); _loadNote(key); })
      .catch(() => showToast('删除失败，请重试'));
  }

  function _renderLightboxExif(exif, p) {
    const el = document.getElementById('lpExif');
    if (!el) return;
    if (!exif || Object.keys(exif).length === 0) { el.innerHTML = ''; return; }

    // Mini map (GPS)
    if (exif.lat !== undefined && exif.lng !== undefined) {
      const slot = document.getElementById('lpMapPlaceholder');
      if (slot) slot.innerHTML = `<a class="lp-mini-map" href="/map?month=${p.month}&day=${p.day}" title="在地图中查看这一天"><img src="/api/static-map?lat=${exif.lat.toFixed(6)}&lng=${exif.lng.toFixed(6)}" alt="拍摄地点" loading="lazy" onerror="this.parentElement.remove()" /></a>`;
    }

    // Append extra rows to 基本信息
    const basicTable = document.getElementById('lpBasicTable');
    if (basicTable) {
      const extras = [];
      if (exif.fileSize) extras.push(['文件大小', _formatFileSize(exif.fileSize)]);
      if (exif.width && exif.height) {
        extras.push(['分辨率', `${exif.width} × ${exif.height}`]);
        extras.push(['像素', `${(exif.width * exif.height / 1e6).toFixed(2)} MP`]);
      }
      if (exif.dateTime) extras.push(['拍摄时间', _formatExifDate(exif.dateTime)]);
      if (exif.offsetTime) extras.push(['时区', exif.offsetTime]);
      if (exif.colorSpace) extras.push(['色彩空间', exif.colorSpace]);
      if (exif.software) extras.push(['软件', exif.software, 'lp-small']);
      if (exif.latDMS) extras.push(['纬度', exif.latDMS]);
      if (exif.lngDMS) extras.push(['经度', exif.lngDMS]);
      if (exif.altitude !== undefined) extras.push(['海拔', `${exif.altitude} m`]);
      for (const [lbl, val, cls] of extras) {
        const div = document.createElement('div');
        div.className = 'lp-row';
        div.innerHTML = `<span class="lp-label">${_lpIcon(lbl)}${lbl}</span><span class="lp-value${cls ? ' ' + cls : ''}">${escHtml(String(val))}</span>`;
        basicTable.appendChild(div);
      }
    }

    let html = '';

    // 拍摄参数
    const shotRows = [];
    if (exif.focalLength35) shotRows.push(['焦距', exif.focalLength35 + ' mm']);
    else if (exif.focalLength) shotRows.push(['焦距', exif.focalLength.toFixed(1) + ' mm']);
    if (exif.aperture) shotRows.push(['光圈', 'f/' + exif.aperture.toFixed(1)]);
    if (exif.shutterSpeed) shotRows.push(['曝光时间', _formatShutter(exif.shutterSpeed)]);
    if (exif.iso) shotRows.push(['ISO', String(exif.iso)]);
    if (shotRows.length) html += _lpSec('拍摄参数', shotRows);

    // 直方图
    html += '<div class="lp-section-title">直方图</div><div class="lp-histogram-wrap"><canvas class="lp-histogram" id="lbHistogram" width="296" height="80"></canvas></div>';

    // 技术参数
    const SM_NAMES = ['','单区域','单次线阵','多区域线阵','一次区域','二维面阵','色线感应'];
    const techRows = [];
    if (exif.brightnessValue !== undefined) techRows.push(['亮度', exif.brightnessValue.toFixed(2) + ' EV']);
    if (exif.sensingMethod !== undefined) techRows.push(['感光方式', SM_NAMES[exif.sensingMethod] || '其他']);
    if (techRows.length) html += _lpSec('技术参数', techRows);

    // 设备信息
    const devRows = [];
    if (exif.make || exif.model) devRows.push(['相机', [exif.make, exif.model].filter(Boolean).join(' ')]);
    if (exif.maxAperture) devRows.push(['最大光圈', 'f/' + exif.maxAperture.toFixed(2)]);
    if (exif.focalLength) devRows.push(['焦距', exif.focalLength.toFixed(1) + ' mm']);
    if (exif.focalLength35) devRows.push(['35mm 等效', exif.focalLength35 + ' mm']);
    if (exif.lens) devRows.push(['镜头', exif.lens, 'lp-small']);
    if (devRows.length) html += _lpSec('设备信息', devRows);

    // 拍摄模式
    const EP_NAMES = ['不定义','手动','程序自动曝光','光圈优先','快门优先','创意模式','运动模式','人像模式','风景模式'];
    const EM_NAMES = ['自动曝光','手动曝光','自动包围曝光'];
    const MM_NAMES = ['未知','平均','中央重点平均测光','点测光','多点测光','多区域测光','局部测光'];
    const SCT_NAMES = ['标准','风景','人像','夜景'];
    const modeRows = [];
    if (exif.whiteBalance !== undefined) modeRows.push(['白平衡', exif.whiteBalance === 0 ? '自动' : '手动']);
    if (exif.exposureProgram !== undefined) modeRows.push(['曝光程序', EP_NAMES[exif.exposureProgram] || '未知']);
    if (exif.exposureMode !== undefined) modeRows.push(['曝光模式', EM_NAMES[exif.exposureMode] || '未知']);
    if (exif.meteringMode !== undefined) modeRows.push(['测光模式', MM_NAMES[exif.meteringMode] || '未知']);
    if (exif.flash !== undefined) modeRows.push(['闪光灯', (exif.flash & 1) ? '已闪光' : '关闭, 不闪光']);
    if (exif.sceneCaptureType !== undefined) modeRows.push(['场景捕捉', SCT_NAMES[exif.sceneCaptureType] || '标准']);
    if (modeRows.length) html += _lpSec('拍摄模式', modeRows);

    el.innerHTML = html;

    // Render histogram after panel is in DOM
    const histCanvas = document.getElementById('lbHistogram');
    if (histCanvas) _renderHistogram(histCanvas);
  }

  function _formatShutter(seconds) {
    if (seconds >= 1) return seconds.toFixed(1) + 's';
    const denom = Math.round(1 / seconds);
    return '1/' + denom + 's';
  }

  let _exifAbort = null;
  function _loadLightboxExif(p) {
    const el = document.getElementById('lpExif');
    if (!el) return;
    if (!/\.(jpe?g|heic)$/i.test(p.key)) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="lp-exif-loading">加载相机信息…</div>';
    const ctrl = new AbortController();
    _exifAbort = ctrl;
    fetch('/api/exif?v=2&key=' + encodeURIComponent(p.key), { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(exif => { if (!ctrl.signal.aborted) _renderLightboxExif(exif, p); })
      .catch(() => { const el2 = document.getElementById('lpExif'); if (el2) el2.innerHTML = ''; });
  }

  function _renderFilmstrip(activeIndex) {
    const strip = document.getElementById('lightboxFilmstrip');
    if (!strip || !allPhotos.length) return;
    strip.innerHTML = allPhotos.map((p, i) => {
      const active = i === activeIndex ? ' active' : '';
      if (p.type === 'video') {
        return `<div class="lfs-item${active}" onclick="renderSlide(${i})"><video src="${escAttr(p.url)}#t=0.5" muted preload="metadata" style="width:100%;height:100%;object-fit:cover"></video><span class="lfs-video-badge">▶</span></div>`;
      }
      const thumb = p.url.replace('/img/', '/thumb/') + '?w=100&q=65&fit=cover';
      return `<div class="lfs-item${active}" onclick="renderSlide(${i})"><img src="${escAttr(thumb)}" loading="lazy" decoding="async" /></div>`;
    }).join('');
    // 滚动到当前项
    const activeEl = strip.children[activeIndex];
    if (activeEl) activeEl.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  function _updateFilmstrip(index) {
    const strip = document.getElementById('lightboxFilmstrip');
    if (!strip) return;
    strip.querySelectorAll('.lfs-item').forEach((el, i) => {
      el.classList.toggle('active', i === index);
    });
    const activeEl = strip.children[index];
    if (activeEl) activeEl.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }

  function renderSlide(index) {
    const p = allPhotos[index];
    if (!p) return;
    currentIndex = index;
    const _ep = document.getElementById('lbEmojiPopup');
    if (_ep) _ep.classList.remove('open');
    lightboxDownload.href = p.url + '?dl=1';
    lightboxDownload.download = p.key.split('/').pop();
    lightboxShare.dataset.url = location.origin + p.url;
    lightboxShare.dataset.year = p.year;
    _lbResetZoom();
    _updateFilmstrip(index);
    _renderLightboxReactions(p.key);
    _renderLightboxInfo(p);
    if (_exifAbort) { _exifAbort.abort(); _exifAbort = null; }
    _loadLightboxExif(p);

    if (_imgLoadAbort) { _imgLoadAbort.abort(); _imgLoadAbort = null; }
    if (_currentBlobUrl) { URL.revokeObjectURL(_currentBlobUrl); _currentBlobUrl = null; }
    _lbAnimating = false;
    const _progReset = document.getElementById('lbLoadProgress');
    if (_progReset) _progReset.classList.remove('visible');

    lightboxBody.style.transition = '';
    lightboxBody.style.transform = '';
    lightboxBody.innerHTML = '';
    // "show" 这个淡入 class 必须等图片/视频真的有数据了才加，不能用固定延时——
    // 不然图片还没下载完就先淡入，看到的就是浏览器原生的"裂图"占位图标，等真实画面到了才覆盖上去
    const showWhenReady = (target) => requestAnimationFrame(() => requestAnimationFrame(() => target.classList.add('show')));

    _lbIsLivePhoto = false;
    const _lbLiveBar = document.getElementById('lbLiveBar');
    if (_lbLiveBar) { _lbLiveBar.innerHTML = ''; _lbLiveBar.classList.remove('playing'); _lbLiveBar.style.opacity = ''; }
    if (p.type === 'video') {
      const el = document.createElement('video');
      el.className = pickEffect();
      el.src = p.url;
      el.controls = !autoPlaying;
      el.muted = autoPlaying;
      el.autoplay = true;
      el.onended = () => { if (autoPlaying) nextSlide(); };
      el.onloadeddata = () => showWhenReady(el);
      lightboxBody.appendChild(el);
    } else if (p.type === 'live') {
      const img = document.createElement('img');
      img.className = pickEffect();
      img.decoding = 'async';

      const video = document.createElement('video');
      video.className = 'live-photo-video';
      video.src = p.videoUrl;
      video.preload = 'metadata';
      // 静音是浏览器允许自动播放的前提，长按带声播放属于用户手势不受限
      video.muted = true;
      video.playsInline = true;

      const wrap = document.createElement('div');
      wrap.className = 'live-photo-wrap';
      wrap.appendChild(img);
      wrap.appendChild(video);
      lightboxBody.appendChild(wrap);

      // 「实况」指示 + 声音开关放在页面左上角（照片外），像素级复刻 lens.bh8.ga：
      // 无底色的白色角标（虚线外圈 + 实线内圈 + 中心点）+ 描边小喇叭，悬停角标才播放
      let badge = null, muteBtn = null;
      if (_lbLiveBar) {
        _lbLiveBar.style.opacity = '0';
        _lbLiveBar.innerHTML =
          '<span class="lp-live-badge">' +
            '<svg class="lp-live-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor">' +
              '<circle cx="10" cy="10" r="8.25" stroke-width="1.5" stroke-dasharray="1.55 2.75" stroke-linecap="round"/>' +
              '<circle cx="10" cy="10" r="4.9" stroke-width="1.5"/>' +
              '<circle cx="10" cy="10" r="1.9" fill="currentColor" stroke="none"/>' +
            '</svg><span class="lp-live-text">实况</span></span>' +
          '<button class="live-photo-mute" type="button">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M11.5 5.2 7.1 8.9H4.6a1 1 0 0 0-1 1v4.2a1 1 0 0 0 1 1h2.5l4.4 3.7z"/>' +
              '<path class="lp-snd-wave" d="M15.2 9.2a4.4 4.4 0 0 1 0 5.6"/>' +
              '<line class="lp-snd-off" x1="15.4" y1="9.6" x2="20.2" y2="14.4"/>' +
              '<line class="lp-snd-off" x1="20.2" y1="9.6" x2="15.4" y2="14.4"/>' +
            '</svg></button>';
        badge = _lbLiveBar.querySelector('.lp-live-badge');
        muteBtn = _lbLiveBar.querySelector('.live-photo-mute');
      }
      const syncMuteBtn = () => {
        if (!muteBtn) return;
        muteBtn.classList.toggle('muted', _lbLiveMuted);
        muteBtn.title = _lbLiveMuted ? '开启声音' : '关闭声音';
        muteBtn.setAttribute('aria-label', muteBtn.title);
      };
      syncMuteBtn();

      const playLive = ({ muted = _lbLiveMuted } = {}) => {
        video.loop = true;
        video.muted = muted;
        video.currentTime = 0;
        wrap.classList.add('playing');
        if (_lbLiveBar) _lbLiveBar.classList.add('playing');
        video.play().catch(() => {
          // 带声播放被自动播放策略拦下时退回静音预览，不改全局开关状态
          if (!muted) { video.muted = true; video.play().catch(() => {}); }
        });
      };
      const stopLive = () => {
        video.pause();
        wrap.classList.remove('playing');
        if (_lbLiveBar) _lbLiveBar.classList.remove('playing');
      };

      // 声音开关：切换全局静音状态；正在播放时立即生效
      if (muteBtn) muteBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        _lbLiveMuted = !_lbLiveMuted;
        syncMuteBtn();
        if (wrap.classList.contains('playing')) video.muted = _lbLiveMuted;
      });

      // 图片加载完成后自动播一次（静音），和苹果相册滑到实况照片时一样
      const liveSrc = p.url.replace('/img/', '/thumb/') + '?w=1600&q=85&fit=scale-down';
      _loadImgWithProgress(liveSrc, img,
        () => {
          showWhenReady(img);
          if (_lbLiveBar) _lbLiveBar.style.opacity = '';
          setTimeout(() => {
            if (!document.body.contains(wrap)) return;
            video.loop = false;
            video.muted = true;
            video.currentTime = 0;
            wrap.classList.add('playing');
            if (_lbLiveBar) _lbLiveBar.classList.add('playing');
            video.play().catch(() => {});
            video.onended = () => {
              wrap.classList.remove('playing');
              if (_lbLiveBar) _lbLiveBar.classList.remove('playing');
            };
          }, 500);
        },
        () => { heicFallback(img, p.url); }
      );

      // 桌面：悬停左上角「实况」角标播放，移开停止——鼠标扫过照片本身不再触发
      if (badge) {
        badge.addEventListener('mouseenter', () => playLive());
        badge.addEventListener('mouseleave', () => stopLive());
        badge.addEventListener('click', (ev) => ev.stopPropagation());
      }
      // 移动端：长按照片（≥350ms）播放（声音跟随开关），松手停止——与苹果相册一致
      let _lpTimer = null;
      const cancelPress = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } };
      wrap.addEventListener('touchstart', (e) => {
        // 双指捏合 / 已放大平移时不触发长按播放
        if (e.touches.length > 1 || _lbScale > 1) { cancelPress(); return; }
        e.preventDefault();
        _lpTimer = setTimeout(() => { _lpTimer = null; playLive({ muted: _lbLiveMuted }); }, 350);
      }, { passive: false });
      wrap.addEventListener('touchend', () => {
        if (_lpTimer) cancelPress();
        else stopLive();
      });
      wrap.addEventListener('touchcancel', () => { cancelPress(); stopLive(); });

      // 提示文字
      _lbIsLivePhoto = true;
      const _hint = document.getElementById('lbZoomHint');
      if (_hint) {
        clearTimeout(_lbZoomHideTimer);
        const isMobileTouch = window.matchMedia('(pointer: coarse)').matches;
        _hint.textContent = isMobileTouch ? '长按播放实况 · 捏合缩放' : '悬停左上「实况」播放 · 旁边按钮开关声音';
        _hint.style.opacity = '1';
        _lbZoomHideTimer = setTimeout(() => { if (_hint) _hint.style.opacity = '0'; }, 3000);
      }
    } else {
      _lbIsLivePhoto = false;
      const el = document.createElement('img');
      el.className = pickEffect();
      el.decoding = 'async';
      const imgSrc = p.url.replace('/img/', '/thumb/') + '?w=1600&q=85&fit=scale-down';
      _loadImgWithProgress(imgSrc, el,
        () => showWhenReady(el),
        () => { heicFallback(el, p.url); }
      );
      lightboxBody.appendChild(el);
    }

    clearTimeout(slideTimer);
    if (autoPlaying && p.type !== 'video') {
      slideTimer = setTimeout(nextSlide, 3000);
    }
  }

  function nextSlide() { renderSlide((currentIndex + 1) % allPhotos.length); }
  function prevSlide() { autoPlaying = false; stopAutoPlay(); renderSlide((currentIndex - 1 + allPhotos.length) % allPhotos.length); }

  function openLightbox(index, asSlideshow) {
    autoPlaying = !!asSlideshow;
    _syncLbPanel();
    lightbox.classList.add('open');
    document.body.classList.add('lb-open');
    document.body.style.overflow = 'hidden';
    if (asSlideshow && lightbox.requestFullscreen) {
      lightbox.requestFullscreen().catch(() => {});
    }
    _renderFilmstrip(index);
    renderSlide(index);
  }
  function stopAutoPlay() {
    autoPlaying = false;
    clearTimeout(slideTimer);
  }
  function closeLightbox() {
    lightbox.classList.remove('open');
    document.body.classList.remove('lb-open');
    const _popup = document.getElementById('lbEmojiPopup');
    if (_popup) _popup.classList.remove('open');
    stopAutoPlay();
    _lbScale = 1; _lbTx = 0; _lbTy = 0; _lbPanning = false;
    _lbPinching = false; _lbPointers.clear();
    lightboxBody.innerHTML = '';
    lightboxBody.classList.remove('zoomed', 'panning');
    document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (_exifAbort) { _exifAbort.abort(); _exifAbort = null; }
    if (_imgLoadAbort) { _imgLoadAbort.abort(); _imgLoadAbort = null; }
    if (_currentBlobUrl) { URL.revokeObjectURL(_currentBlobUrl); _currentBlobUrl = null; }
    _lbAnimating = false;
    const _prog = document.getElementById('lbLoadProgress');
    if (_prog) _prog.classList.remove('visible');
    const strip = document.getElementById('lightboxFilmstrip');
    if (strip) strip.innerHTML = '';
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && lightbox.classList.contains('open') && autoPlaying) closeLightbox();
  });

  // 详细信息面板开关：触屏设备（手机/平板）默认收起——iPad 上 390px 的侧栏会把照片挤成一小块，
  // 点顶栏 ⓘ 再展开；桌面鼠标环境默认展开。选择在本次会话内记住，刷新回到默认
  let _lbPanelOpen = !window.matchMedia('(pointer: coarse)').matches;
  function _syncLbPanel() {
    lightbox.classList.toggle('panel-hidden', !_lbPanelOpen);
    const infoBtn = document.getElementById('lightboxInfo');
    if (infoBtn) infoBtn.classList.toggle('active', _lbPanelOpen);
  }
  document.getElementById('lightboxInfo').onclick = () => { _lbPanelOpen = !_lbPanelOpen; _syncLbPanel(); };

  document.getElementById('lightboxClose').onclick = closeLightbox;
  lightboxShare.onclick = async (e) => {
    e.preventDefault();
    const url = lightboxShare.dataset.url;
    const text = lightboxShare.dataset.year + ' 年的今天';
    if (navigator.share) {
      try { await navigator.share({ title: '那年今日', text, url }); }
      catch {} // 用户取消分享，静默忽略
    } else {
      try {
        await navigator.clipboard.writeText(url);
        showToast('链接已复制');
      } catch {
        showToast('复制失败，请手动复制链接');
      }
    }
  };
  document.getElementById('navPrev').onclick = (e) => { e.stopPropagation(); prevSlide(); };
  document.getElementById('navNext').onclick = (e) => { e.stopPropagation(); autoPlaying = false; nextSlide(); };
  lightbox.onclick = (e) => { if (e.target === lightbox) closeLightbox(); };
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') { if (_lbScale > 1) { _lbResetZoom(); } else { closeLightbox(); } }
    if (e.key === 'ArrowRight' && _lbScale === 1) { autoPlaying = false; nextSlide(); }
    if (e.key === 'ArrowLeft' && _lbScale === 1) prevSlide();
    if ((e.key === '=' || e.key === '+') && _lbScale < 10) { _lbScale = Math.min(10, _lbScale * 1.3); _lbApplyTransform(); }
    if (e.key === '-' && _lbScale > 1) { _lbScale = Math.max(1, _lbScale / 1.3); if (_lbScale <= 1) { _lbScale=1; _lbTx=0; _lbTy=0; } _lbApplyTransform(); }
    if (e.key === '0') _lbResetZoom();
  });

  // ── 灯箱图片缩放 + 平移 ─────────────────────────────────────────────────────
  let _lbScale = 1, _lbTx = 0, _lbTy = 0;
  let _lbPanning = false, _lbPanSX = 0, _lbPanSY = 0, _lbPanTx0 = 0, _lbPanTy0 = 0, _lbPanMoved = false;
  let _lbSlideDragX = 0, _lbSlideDragY = 0, _lbSlideDragging = false, _lbSlideActive = false;
  // 多指捏合缩放：按 pointerId 记录每根手指当前位置，两指同时按下时进入捏合手势
  const _lbPointers = new Map();
  let _lbPinching = false, _lbPinchStartDist = 1, _lbPinchStartScale = 1;
  let _lbPinchAnchorX = 0, _lbPinchAnchorY = 0; // 捏合中心相对元素中心的偏移（未缩放坐标系），缩放过程中让这个点尽量不动
  // 手动判定双击/双击：移动端浏览器合成的 dblclick 不可靠（下面会说明原因），
  // 改成自己在 pointerup 里比较两次点击的时间和位置
  let _lastTapTime = 0, _lastTapX = 0, _lastTapY = 0;
  let _lastZoomToggleAt = 0;
  let _lbZoomHideTimer = null;
  let _imgLoadAbort = null;
  let _lbDragEndTime = 0;
  let _lbAnimating = false;
  let _currentBlobUrl = null;
  let _lbIsLivePhoto = false;
  // 实况照片声音开关（跨照片记忆）；默认开声（同 lens.bh8.ga），
  // 悬停播放被浏览器自动播放策略拦下时会临时退回静音，不改这个全局状态
  let _lbLiveMuted = false;

  function _loadImgWithProgress(url, img, onReady, onError) {
    const progEl = document.getElementById('lbLoadProgress');
    const ctrl = new AbortController();
    _imgLoadAbort = ctrl;
    if (progEl) {
      progEl.innerHTML = '<span class="lb-prog-spin"></span><span>正在加载</span>';
      progEl.classList.add('visible');
    }
    const hide = () => { if (progEl) progEl.classList.remove('visible'); };
    fetch(url, { signal: ctrl.signal })
      .then(r => {
        const total = parseInt(r.headers.get('content-length')) || 0;
        const reader = r.body.getReader();
        const chunks = [];
        let loaded = 0;
        function pump() {
          return reader.read().then(({ done, value }) => {
            if (ctrl.signal.aborted) return;
            if (done) {
              if (_currentBlobUrl) { URL.revokeObjectURL(_currentBlobUrl); _currentBlobUrl = null; }
              const blob = new Blob(chunks);
              const objUrl = URL.createObjectURL(blob);
              _currentBlobUrl = objUrl;
              img.onload = () => { _currentBlobUrl = null; hide(); if (_imgLoadAbort === ctrl) _imgLoadAbort = null; URL.revokeObjectURL(objUrl); onReady(); };
              img.onerror = () => { _currentBlobUrl = null; hide(); if (_imgLoadAbort === ctrl) _imgLoadAbort = null; URL.revokeObjectURL(objUrl); if (onError) onError(); };
              img.src = objUrl;
              return;
            }
            chunks.push(value);
            loaded += value.length;
            if (progEl && !ctrl.signal.aborted) {
              const pct = total ? Math.round(loaded / total * 100) : null;
              const txt = total
                ? `正在加载 ${pct}% · ${_formatFileSize(loaded)} / ${_formatFileSize(total)}`
                : `正在加载 · ${_formatFileSize(loaded)}`;
              progEl.innerHTML = `<span class="lb-prog-spin"></span><span>${txt}</span>`;
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(err => {
        if (ctrl.signal.aborted) return;
        hide();
        img.onload = () => { if (_imgLoadAbort === ctrl) _imgLoadAbort = null; onReady(); };
        img.onerror = () => { if (_imgLoadAbort === ctrl) _imgLoadAbort = null; if (onError) onError(); };
        img.src = url;
      });
  }

  function _lbTarget() { return lightboxBody.querySelector('img,video,.live-photo-wrap'); }

  function _lbClamp() {
    if (_lbScale <= 1) return;
    const t = _lbTarget();
    if (!t) return;
    const stage = lightboxBody.parentElement;
    const scaledW = t.offsetWidth  * _lbScale;
    const scaledH = t.offsetHeight * _lbScale;
    const maxX = Math.max(0, (scaledW - stage.offsetWidth)  / 2);
    const maxY = Math.max(0, (scaledH - stage.offsetHeight) / 2);
    _lbTx = Math.max(-maxX, Math.min(maxX, _lbTx));
    _lbTy = Math.max(-maxY, Math.min(maxY, _lbTy));
  }

  function _lbApplyTransform() {
    const t = _lbTarget();
    if (!t) return;
    t.style.transform = _lbScale === 1 ? '' : `translate(${_lbTx}px,${_lbTy}px) scale(${_lbScale})`;
    t.style.transformOrigin = 'center center';
    lightboxBody.classList.toggle('zoomed', _lbScale > 1);
    // 左下角缩放比例徽章
    const badge = document.getElementById('lbScaleBadge');
    if (badge) {
      if (_lbScale > 1) {
        badge.textContent = `${(_lbScale).toFixed(1)}×`;
        badge.classList.add('visible');
      } else {
        badge.classList.remove('visible');
      }
    }
    // 底部中央：未缩放时显示操作提示，缩放中隐藏
    const hint = document.getElementById('lbZoomHint');
    if (hint) {
      clearTimeout(_lbZoomHideTimer);
      if (_lbScale > 1) {
        hint.style.opacity = '0';
      } else if (!_lbIsLivePhoto) {
        hint.textContent = '双击或用鼠标滚轮缩放';
        hint.style.opacity = '1';
        _lbZoomHideTimer = setTimeout(() => { if (hint) hint.style.opacity = '0'; }, 2500);
      }
    }
  }

  function _lbResetZoom() {
    _lbScale = 1; _lbTx = 0; _lbTy = 0;
    _lbPinching = false; _lbPointers.clear();
    lightboxBody.classList.remove('zoomed', 'panning');
    _lbApplyTransform();
  }

  // 双击/双击缩放的共用逻辑：桌面 dblclick 和移动端手动判定的双击都调这个
  function _lbToggleZoom(clientX, clientY) {
    // 防抖：同一次双击有极小概率同时触发"手动判定"和浏览器合成的 dblclick，
    // 不加这道栏杆会看到缩放"闪一下"又弹回去
    const now = Date.now();
    if (now - _lastZoomToggleAt < 250) return;
    _lastZoomToggleAt = now;

    const t = _lbTarget();
    if (!t) return;
    if (_lbScale > 1) {
      _lbResetZoom();
    } else {
      const stage = lightboxBody.parentElement;
      const rect = stage.getBoundingClientRect();
      const vcx = stage.offsetWidth / 2;
      const vcy = stage.offsetHeight / 2;
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      const newScale = 2.5;
      _lbTx += (vcx - cx) * (newScale - 1);
      _lbTy += (vcy - cy) * (newScale - 1);
      _lbScale = newScale;
      _lbClamp();
      _lbApplyTransform();
    }
  }

  // 触屏没有原生 dblclick 可靠可用（见下面 pointerup 里的说明），自己比较两次
  // 点击的时间间隔和位置距离；触发过一次之后清零计时，避免连续三击被算成第二次双击
  function _checkDoubleTap(x, y) {
    const now = Date.now();
    const isDouble = now - _lastTapTime < 300 && Math.hypot(x - _lastTapX, y - _lastTapY) < 30;
    _lastTapTime = isDouble ? 0 : now;
    _lastTapX = x; _lastTapY = y;
    if (isDouble) _lbToggleZoom(x, y);
  }

  // ── 双指捏合缩放 ─────────────────────────────────────────────────────────────
  function _pinchDist() {
    const pts = [..._lbPointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
  function _pinchMid() {
    const pts = [..._lbPointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }
  function _startPinch() {
    _lbPinching = true;
    _lbPanning = false; _lbSlideActive = false; _lbSlideDragging = false;
    lightboxBody.classList.remove('panning');
    lightboxBody.style.transition = 'none';
    lightboxBody.style.transform = ''; // 取消可能正在进行中的横滑切图位移
    _lbPinchStartDist = _pinchDist() || 1;
    _lbPinchStartScale = _lbScale;
    const t = _lbTarget();
    if (t) {
      const rect = t.getBoundingClientRect();
      const mid = _pinchMid();
      _lbPinchAnchorX = (mid.x - (rect.left + rect.width / 2)) / _lbScale;
      _lbPinchAnchorY = (mid.y - (rect.top + rect.height / 2)) / _lbScale;
    }
  }
  function _endPinch() {
    _lbPinching = false;
    if (_lbScale <= 1) { _lbScale = 1; _lbTx = 0; _lbTy = 0; _lbApplyTransform(); return; }
    // 松开一根手指后如果还剩一根，无缝切到单指平移——用剩下那根手指的当前坐标当新基准，
    // 不然松开的瞬间平移基准点没跟着换，画面会跳一下
    const remaining = [..._lbPointers.values()][0];
    if (remaining) {
      _lbPanning = true;
      _lbPanMoved = false;
      lightboxBody.classList.add('panning');
      _lbPanSX = remaining.x; _lbPanSY = remaining.y;
      _lbPanTx0 = _lbTx; _lbPanTy0 = _lbTy;
    }
  }

  // 滚轮缩放：以鼠标所在点为缩放中心
  lightboxBody.addEventListener('wheel', (e) => {
    if (!lightbox.classList.contains('open')) return;
    e.preventDefault();
    const t = _lbTarget();
    if (!t) return;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const oldScale = _lbScale;
    const newScale = Math.max(1, Math.min(10, oldScale * factor));
    if (newScale === oldScale) return;
    // 以光标为不动点：dx/dy 是光标相对于元素视觉中心的偏移（在元素本地空间）
    const rect = t.getBoundingClientRect();
    const vcx = rect.left + rect.width / 2;
    const vcy = rect.top + rect.height / 2;
    const dx = (e.clientX - vcx) / oldScale;
    const dy = (e.clientY - vcy) / oldScale;
    _lbTx += dx * (oldScale - newScale);
    _lbTy += dy * (oldScale - newScale);
    _lbScale = newScale;
    if (_lbScale === 1) { _lbTx = 0; _lbTy = 0; }
    _lbClamp();
    _lbApplyTransform();
  }, { passive: false });

  // 浏览器对 <img> 有原生拖拽行为（拖出半透明幻影），会把 pointermove/up 序列
  // 直接打断（触发 pointercancel），放大后的平移根本走不起来——必须整体禁掉
  lightboxBody.addEventListener('dragstart', (e) => e.preventDefault());

  // 放大时拖拽平移；未放大时水平拖动整体 lightboxBody 切换图片；两指同时按下时进入捏合缩放。
  // 统一在 pointerdown 就 setPointerCapture——捏合需要同时稳定收到两根手指各自的 move/up，
  // 不能像以前那样只在"确认是一次有效拖动"之后才补 capture
  lightboxBody.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    _lbPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lightboxBody.setPointerCapture(e.pointerId);

    if (_lbPointers.size >= 2) {
      e.preventDefault();
      _startPinch();
      return;
    }

    if (_lbScale > 1) {
      e.preventDefault(); // 拦截原生图片拖拽/文字选择，把手势留给平移
      e.stopPropagation();
      _lbPanning = true;
      _lbPanMoved = false;
      lightboxBody.classList.add('panning');
      _lbPanSX = e.clientX; _lbPanSY = e.clientY;
      _lbPanTx0 = _lbTx; _lbPanTy0 = _lbTy;
    } else if (allPhotos.length > 1) {
      _lbSlideDragX = e.clientX;
      _lbSlideDragY = e.clientY;
      _lbSlideDragging = false;
      _lbSlideActive = true;
    }
  });
  lightboxBody.addEventListener('pointermove', (e) => {
    if (_lbPointers.has(e.pointerId)) _lbPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (_lbPinching) {
      if (_lbPointers.size < 2) return;
      const dist = _pinchDist() || 1;
      _lbScale = Math.max(1, Math.min(10, _lbPinchStartScale * (dist / _lbPinchStartDist)));
      if (_lbScale === 1) { _lbTx = 0; _lbTy = 0; }
      else {
        // 锚点固定在手势开始时的捏合中心，缩放过程中该点在屏幕上尽量不动
        _lbTx = -_lbPinchAnchorX * (_lbScale - 1);
        _lbTy = -_lbPinchAnchorY * (_lbScale - 1);
      }
      _lbClamp();
      _lbApplyTransform();
      return;
    }

    if (_lbPanning) {
      _lbTx = _lbPanTx0 + e.clientX - _lbPanSX;
      _lbTy = _lbPanTy0 + e.clientY - _lbPanSY;
      if (Math.abs(e.clientX - _lbPanSX) > 6 || Math.abs(e.clientY - _lbPanSY) > 6) _lbPanMoved = true;
      _lbClamp();
      const t = _lbTarget();
      if (t) t.style.transform = `translate(${_lbTx}px,${_lbTy}px) scale(${_lbScale})`;
    } else if (_lbSlideActive) {
      const dx = e.clientX - _lbSlideDragX;
      const dy = e.clientY - _lbSlideDragY;
      if (!_lbSlideDragging) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx)) { _lbSlideActive = false; return; }
        _lbSlideDragging = true;
        // 切图手势开始时停止实况播放，避免干扰
        const lpWrap = lightboxBody.querySelector('.live-photo-wrap.playing');
        if (lpWrap) { const v = lpWrap.querySelector('video'); if (v) v.pause(); lpWrap.classList.remove('playing'); }
      }
      lightboxBody.style.transition = 'none';
      lightboxBody.style.transform = `translateX(${dx}px)`;
    }
  });
  lightboxBody.addEventListener('pointerup', (e) => {
    _lbPointers.delete(e.pointerId);

    if (_lbPinching) { _endPinch(); return; }

    if (_lbPanning) {
      _lbPanning = false;
      lightboxBody.classList.remove('panning');
      // 放大状态下按下又原地抬起（没有产生平移）＝一次点按，交给双击判定
      if (!_lbPanMoved && e.pointerType !== 'mouse') _checkDoubleTap(e.clientX, e.clientY);
    } else if (_lbSlideActive) {
      _lbSlideActive = false;
      if (_lbSlideDragging) {
        _lbSlideDragging = false;
        _lbDragEndTime = Date.now();
        const dx = e.clientX - _lbSlideDragX;
        if (Math.abs(dx) > 80 && !_lbAnimating) {
          autoPlaying = false;
          _lbAnimating = true;
          const dir = dx < 0 ? -1 : 1;
          lightboxBody.style.transition = 'transform 0.28s cubic-bezier(0.4,0,0.2,1)';
          lightboxBody.style.transform = `translateX(${dir * window.innerWidth}px)`;
          setTimeout(() => {
            _lbAnimating = false;
            lightboxBody.style.transition = 'none';
            lightboxBody.style.transform = '';
            if (dx < 0) nextSlide(); else prevSlide();
          }, 280);
        } else {
          lightboxBody.style.transition = 'transform 0.25s ease';
          lightboxBody.style.transform = '';
          setTimeout(() => { lightboxBody.style.transition = ''; }, 260);
        }
      } else if (e.pointerType !== 'mouse') {
        // 未缩放状态下没有产生横滑位移的抬起＝一次点按，交给双击判定
        _checkDoubleTap(e.clientX, e.clientY);
      }
    }
  });
  lightboxBody.addEventListener('pointercancel', (e) => {
    _lbPointers.delete(e.pointerId);
    if (_lbPinching) { _endPinch(); return; }
    if (_lbPanning) {
      _lbPanning = false;
      lightboxBody.classList.remove('panning');
    } else if (_lbSlideActive || _lbSlideDragging) {
      _lbSlideActive = false; _lbSlideDragging = false;
      lightboxBody.style.transition = 'transform 0.25s ease';
      lightboxBody.style.transform = '';
      setTimeout(() => { lightboxBody.style.transition = ''; }, 260);
    }
  });

  // 桌面鼠标双击缩放：在当前点放大到 2.5×，再次双击复原。
  // 移动端不靠这个——触屏的 dblclick 合成不可靠：上面 pointerdown 为了不让浏览器把
  // 双击当成"尝试原生缩放"吞掉（见 #lightboxBody 的 touch-action:none 注释）会
  // preventDefault，一部分浏览器因此干脆不再合成 dblclick，双击缩放会跟着失效——
  // 所以触屏走的是 pointerup 里 _checkDoubleTap 的手动判定，两条路径共用 _lbToggleZoom
  lightboxBody.addEventListener('dblclick', (e) => {
    e.preventDefault();
    _lbToggleZoom(e.clientX, e.clientY);
  });

  // ── 移动端左右滑动切换，不用非得点那两个小箭头 ─────────────────────────────
  let touchStartX = 0, touchStartY = 0;
  lightbox.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    if (_lbScale > 1) return;
    if (_lbSlideDragging || _lbSlideActive || _lbAnimating) return; // pointer events are handling this
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    autoPlaying = false;
    if (dx < 0) nextSlide(); else prevSlide();
  }, { passive: true });

  // "指尖滑过"照片墙：不只是单张图响应鼠标，而是按距离衰减让指尖经过的几张照片联动倾斜，
  // 像一只手指划过墙面逐张拂过去的感觉；同时一个发光的指尖光点跟随鼠标，带一点缓冲延迟。
  const RIPPLE_RADIUS = 230;
  let pointerX = -9999, pointerY = -9999, pointerActive = false;
  let fingerX = -9999, fingerY = -9999;
  const fingertip = document.getElementById('fingertip');
  const cursorDot = document.getElementById('cursorDot');
  const CURSOR_HOVER_SELECTOR = 'a, button, .cell, input, label, [onclick]';

  document.addEventListener('mousemove', (e) => {
    if (_isTouchDevice) return; // 触屏合成的 mousemove 直接丢弃
    pointerX = e.clientX; pointerY = e.clientY; pointerActive = true;
    document.body.classList.add('custom-cursor-active');
    if (cursorDot) {
      cursorDot.style.opacity = '1';
      cursorDot.style.left = pointerX + 'px';
      cursorDot.style.top = pointerY + 'px';
      cursorDot.classList.toggle('hover', !!e.target.closest(CURSOR_HOVER_SELECTOR));
    }
  });
  document.addEventListener('mouseleave', () => {
    pointerActive = false;
    if (cursorDot) cursorDot.style.opacity = '0';
    // 鼠标离开页面时一次性清掉所有"指尖联动"的倾斜状态，不用等 wallTick 下一帧再清
    for (const cell of visibleCells) {
      cell.classList.remove('touching');
      cell.style.transform = '';
    }
  });

  // 只对视口附近（含一点缓冲）的照片做指尖联动计算，照片墙很长时也不用每帧遍历全部 cell
  const visibleCells = new Set();
  const frameInnerCache = new WeakMap(); // 缓存 .frame-inner 引用，不用每次重新 querySelector

  // 缓存每张可见照片的中心点坐标——这才是"鼠标一动就卡"的真正原因：
  // 原来 wallTick 每帧（鼠标在动的时候）都对所有可见照片强制触发一次布局重排去算位置，
  // 现在只在滚动/缩放窗口时才重新算一遍，鼠标移动本身不再触发任何布局读取
  const cellCenters = new Map();
  function refreshCellCenters() {
    for (const cell of visibleCells) {
      const inner = frameInnerCache.get(cell) || cell;
      const rect = inner.getBoundingClientRect();
      cellCenters.set(cell, { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, w: rect.width, h: rect.height });
    }
  }
  let refreshQueued = false;
  function queueRefreshCellCenters() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshCellCenters(); refreshQueued = false; });
  }
  window.addEventListener('scroll', queueRefreshCellCenters, { passive: true });
  window.addEventListener('resize', queueRefreshCellCenters, { passive: true });

  const cellObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visibleCells.add(entry.target);
        entry.target.classList.remove('offscreen');
        // IntersectionObserver 自己就算好了 boundingClientRect，直接拿来用，不用再查一次
        const r = entry.boundingClientRect;
        frameInnerCache.set(entry.target, entry.target.querySelector('.frame-inner') || entry.target);
        cellCenters.set(entry.target, { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height });
      } else {
        visibleCells.delete(entry.target);
        cellCenters.delete(entry.target);
        entry.target.classList.remove('touching');
        entry.target.style.transform = '';
        // 滚出视野的照片把晃动/加载圈动画暂停掉，照片多的时候一堆元素同时跑动画会让页面变卡
        entry.target.classList.add('offscreen');
      }
    }
  }, { rootMargin: '200px' });

  // 独立视频 cell 用 data-src 占位，进视口附近才真正赋值触发加载——<video> 标签本身不支持
  // loading="lazy"，不接这个的话一进页面所有视频会同时发起 Range 请求抢带宽，体感卡顿
  const videoLazyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const v = entry.target;
      v.src = v.dataset.src;
      v.removeAttribute('data-src');
      videoLazyObserver.unobserve(v);
    }
  }, { rootMargin: '300px' });

  // 触屏设备：tap 会合成 mousemove，若让 rAF 对卡片施加 scale/rotateX，
  // 会与 grid 布局和 transform-origin:top center 叠加，滚动时产生比例错乱；
  // 触屏完全不需要 3D 倾斜效果，直接跳过整个 tilt 循环。
  const _isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

  function wallTick() {
    requestAnimationFrame(wallTick);

    // 指尖光点用 lerp 缓冲跟随，制造轻微的"跟手"延迟感
    fingerX += (pointerX - fingerX) * 0.18;
    fingerY += (pointerY - fingerY) * 0.18;
    if (fingertip) {
      fingertip.style.opacity = pointerActive ? '1' : '0';
      fingertip.style.transform = 'translate(' + fingerX + 'px,' + fingerY + 'px) translate(-50%,-50%)';
    }

    // 触屏设备跳过鼠标 3D 倾斜（tap 会合成 mousemove 导致 scale 被写入）
    if (_isTouchDevice) return;

    // 鼠标没在页面上动的时候，没必要每帧都去算每张照片的距离；
    // 鼠标离开时已经在 mouseleave 里把 touching 状态一次性清过了
    if (!pointerActive) return;

    for (const cell of visibleCells) {
      const center = cellCenters.get(cell);
      if (!center) continue; // 用缓存的坐标，不在这里触发任何布局读取
      const dx = pointerX - center.cx, dy = pointerY - center.cy;
      const dist = Math.hypot(dx, dy);

      if (dist < RIPPLE_RADIUS) {
        const factor = 1 - dist / RIPPLE_RADIUS; // 0~1，越近越强
        const px = dx / center.w, py = dy / center.h;
        const baseTilt = cell.style.getPropertyValue('--tilt-deg') || '0';
        cell.classList.add('touching');
        cell.style.transform =
          'rotate(' + baseTilt + 'deg) perspective(700px) ' +
          'rotateX(' + (-py * 18 * factor).toFixed(2) + 'deg) rotateY(' + (px * 18 * factor).toFixed(2) + 'deg) ' +
          'scale(' + (1 + 0.08 * factor).toFixed(3) + ')';
      } else if (cell.classList.contains('touching')) {
        cell.classList.remove('touching');
        cell.style.transform = '';
      }
    }
  }
  requestAnimationFrame(wallTick);

  // 每次调用递增，旧请求返回时 seq 已变则丢弃，防止快速切换日期时旧数据覆盖新内容
  let _memSeq = 0;
  // 首次加载时骨架屏已摆好，等数据到了再淡出骨架→淡入真实内容；后续切换则立即淡出旧内容
  let _memFirstLoad = true;

  // 切日期时（navigateToDate/popstate）会用新的 month/day 再调一次这个函数，原地刷新内容，
  // 不会触发整页 location.href 跳转——声明成 function 而不是 const，靠 hoisting 保证在它定义之前
  // 出现的 navigateToDate/popstate 里提前引用到它也没问题
  function loadMemories(month, day) {
    const content = document.getElementById('content');
    const subtitle = document.getElementById('subtitle');
    const FADE_MS = 220; // 跟 #content 的 CSS transition 时长对齐，不然淡出动画没走完就被打断，看起来像卡顿
    const seq = ++_memSeq;
    const isFirst = _memFirstLoad;
    _memFirstLoad = false;

    // 历史上的今天跟着这次要看的日期一起换，独立请求互不阻塞
    loadOnThisDay(month, day);

    // 骨架屏的卡片直接复用真实照片用的 .cell/.frame-inner——尺寸/倾斜角/摇摆节奏的算法
    // 也跟下面渲染真实照片时的 pickSize/pickTilt 保持一致（seed 就用数组下标），
    // 这样骨架屏看起来就是同一套"墙上挂照片"，而不是另一套临时拼凑的占位符
    const SKELETON_SIZES = [150, 190, 230, 170, 210];
    const SKELETON_TILTS = [-3, -1.5, 0, 1.5, 3];
    const SKELETON_HTML = '<div class="skeleton-grid">' + SKELETON_SIZES.map((w, i) => {
      const swayDur = (4 + (i % 4) * 0.7).toFixed(1);
      const swayDelay = ((i % 5) * 0.5).toFixed(1);
      const enterDelay = (i * 0.05).toFixed(2);
      const style = 'width:' + w + 'px;--tilt-deg:' + SKELETON_TILTS[i] + ';--sway-dur:' + swayDur + 's;--sway-delay:' + swayDelay + 's;--enter-delay:' + enterDelay + 's;';
      return '<div class="cell" style="' + style + '"><div class="frame-inner"></div></div>';
    }).join('') + '</div>';

    function fadeOut() {
      content.style.opacity = '0';
      return new Promise((resolve) => setTimeout(resolve, FADE_MS));
    }
    function fadeIn() {
      requestAnimationFrame(() => requestAnimationFrame(() => { content.style.opacity = '1'; }));
    }

    // showedSkeleton 记的是骨架屏有没有真的画出来过；fetchSettled 记数据是不是已经落定（成功或失败都算）。
    // 网络够快时，220ms 的退场动画还没跑完数据就已经到了——这时候没必要再画一遍骨架屏自己又淡入，
    // 不然真实内容马上又要把它淡出换掉，平白多一轮闪烁；骨架屏那边的淡入还用的是双 rAF（下一帧才生效），
    // 跟真实内容几乎同时触发的淡入抢着改 opacity，谁后跑谁赢，体感就是"数据明明到了却还卡一下骨架屏"
    let showedSkeleton = false;
    let fetchSettled = false;

    // 切日期：旧内容先淡出，再换成骨架屏淡入——中间不再是一片空白（衬着纯黑背景看起来像黑屏/卡死），
    // 骨架屏的脉冲动画能让用户看出"正在加载"。首次加载本来就是骨架屏直出，不用走这一步
    let skeletonReady = Promise.resolve();
    if (!isFirst) {
      subtitle.textContent = '正在唤醒回忆…';
      yearToggle.disabled = true;
      visibleCells.clear();
      cellCenters.clear();
      allPhotos = [];
      skeletonReady = fadeOut().then(() => {
        if (seq !== _memSeq) return;
        if (!fetchSettled) {
          showedSkeleton = true;
          content.innerHTML = SKELETON_HTML;
          fadeIn();
        }
      });
    }

    const includeLunarForRequest = calendarMode === 'lunar';
    const fetchPromise = fetch('/api/memories?month=' + month + '&day=' + day + (includeLunarForRequest ? '&lunar=1' : '&lunar=0')).then(r => {
      if (!r.ok) throw new Error('memories fetch failed: ' + r.status);
      return r.json();
    });
    // 独立的旁路 .then，只用来记"落没落定"，不影响 fetchPromise 本身往 Promise.all 传播的 resolve/reject
    fetchPromise.then(() => { fetchSettled = true; }, () => { fetchSettled = true; });

    Promise.all([skeletonReady, fetchPromise]).then(([, data]) => {
      if (seq !== _memSeq) return; // 用户已切换到别的日期，丢弃过期结果

      const apply = () => {
        document.getElementById('title').innerHTML = '<span class="date">' + data.month + '月' + data.day + '日</span>，那些年的此刻';
        _joinRoom(data.month + '-' + data.day);

        // 农历同日段落（后端算好：同一农历日在往年对应的公历日期的照片，公历同日重复的已排除）
        const lunarYears = includeLunarForRequest && data.lunar ? (data.lunar.years || []) : [];
        const visibleYears = includeLunarForRequest ? lunarYears : data.years;

        if (!visibleYears.length) {
          subtitle.textContent = '这一天，还没有故事';
          content.innerHTML = '<div class="empty">去拍一张，留给未来的自己</div>';
          fadeIn();
          return;
        }

        const totalPhotos = visibleYears.reduce((s, y) => s + y.photos.length, 0);
        subtitle.textContent = (includeLunarForRequest ? '农历同日' : '公历同日')
          + '横跨 ' + visibleYears.length + ' 个年头，' + totalPhotos + ' 个瞬间';

        // 切日期会把整面墙的照片换掉，旧的 cell 元素马上就从 DOM 里消失了——
        // 不清的话 visibleCells/cellCenters 里攒着的是已经被扔掉的旧元素引用，越点几次日期切换越积越多
        if (isFirst) {
          visibleCells.clear();
          cellCenters.clear();
          allPhotos = [];
        }
        // allPhotos 必须只包含当前模式正在展示的照片，灯箱下标才不会串到另一套历法。
        visibleYears.forEach(y => y.photos.forEach(p => allPhotos.push({ ...p, year: y.year })));

        // 给每张图随机一个尺寸档位、轻微倾斜角度，再配一个随机的晃动周期和延迟，做出挂在墙上被风吹的参差感
        const SIZES = [150, 190, 230, 170, 210];
        function pickSize(seed) { return SIZES[seed % SIZES.length]; }
        function pickTilt(seed) { const angles = [-3, -1.5, 0, 1.5, 3]; return angles[seed % angles.length]; }

        // 一年的照片太多时，先精选一部分摆出来：视频/Live Photo 优先收录，然后是 AI 打过分的高分照片，
        // 剩下名额（包括还没被 AI 打分的）按时间均匀抽样，保证不是"挤在某一段"，而是有代表性的几个瞬间
        const FEATURED_LIMIT = 10;
        function pickFeatured(photos, limit) {
          if (photos.length <= limit) return null; // null 表示不需要折叠，全部都是精选
          const featured = new Set();
          photos.forEach((p, i) => { if ((p.type === 'video' || p.type === 'live') && featured.size < limit) featured.add(i); });

          // 带坐标 + 检测到人脸的"真实拍摄"照片最优先（screenshots/表情包之类的一般没有这两样），
          // 同样按 AI 分数从高到低排
          const realPhotoIdx = photos
            .map((p, i) => ({ i, score: p.score }))
            .filter(({ i, score }) => !featured.has(i) && typeof score === 'number' && photos[i].hasFace && photos[i].place)
            .sort((a, b) => b.score - a.score);
          for (const { i } of realPhotoIdx) {
            if (featured.size >= limit) break;
            featured.add(i);
          }

          // 剩下名额里，AI 打过分的非视频照片按分数从高到低收录
          const scoredIdx = photos
            .map((p, i) => ({ i, score: p.score }))
            .filter(({ i, score }) => !featured.has(i) && typeof score === 'number')
            .sort((a, b) => b.score - a.score);
          for (const { i } of scoredIdx) {
            if (featured.size >= limit) break;
            featured.add(i);
          }

          // 还没打分的照片（或者 AI 还没跑过），按时间均匀抽样补满剩下的名额
          const remainingIdx = photos.map((_, i) => i).filter((i) => !featured.has(i));
          const need = limit - featured.size;
          if (need > 0 && remainingIdx.length > 0) {
            const step = remainingIdx.length / need;
            for (let k = 0; k < need; k++) {
              featured.add(remainingIdx[Math.min(remainingIdx.length - 1, Math.floor(k * step))]);
            }
          }
          return featured;
        }

        window.toggleShowMore = function (btn) {
          const grid = btn.previousElementSibling;
          const expanded = grid.classList.toggle('expanded');
          const total = btn.dataset.total;
          btn.textContent = expanded ? '收起' : '展开查看全部 ' + total + ' 张 ›';
        };

        // 移动端用 CSS Grid repeat(2,1fr)：实际渲染宽 = (viewport - year-block水平padding - gap) / 2
        // year-block padding 1rem*2≈32px，gap 14px，所以 1fr ≈ (innerWidth-46)/2
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const isMobileLayout = window.innerWidth <= 640;
        const mobileRenderSize = Math.round((window.innerWidth - 46) / 2);

        // 照片不是一次性全部弹出来，按页面上的出场顺序错开一点时间依次淡入；
        // 延迟封顶（0.9s），照片特别多的时候后面那些不用傻等，很快就一起跟上
        let globalCellIndex = 0;
        const renderYearBlock = (y, idPrefix) => {
          const featured = pickFeatured(y.photos, FEATURED_LIMIT);
          const extraCount = featured ? y.photos.length - featured.size : 0;
          const cells = y.photos.map((p, pi) => {
            // allPhotos 是按完全相同的 年->照片 嵌套顺序铺出来的，flatIndex 直接用这个递增计数器就是它在
            // allPhotos 里的下标，不用每张照片都 findIndex 整个数组查一遍——照片一多，那是 O(n²) 的隐藏开销，
            // 切日期时一大批照片同时算就是页面卡顿的一部分
            const flatIndex = globalCellIndex;
            const size = pickSize(pi + y.year.charCodeAt(0));
            const tilt = pickTilt(pi);
            const swayDur = (4 + (pi % 4) * 0.7).toFixed(1);
            const swayDelay = ((pi % 5) * 0.5).toFixed(1);
            const enterDelay = Math.min(globalCellIndex * 0.05, 0.9).toFixed(2);
            globalCellIndex++;
            // 不再固定 height——照片按原图比例显示，宽度定了，高度交给 frame-inner 的 aspect-ratio 撑出来
            const style = `width:${size}px;--tilt-deg:${tilt};--sway-dur:${swayDur}s;--sway-delay:${swayDelay}s;--enter-delay:${enterDelay}s;`;
            const extraClass = featured && !featured.has(pi) ? ' extra' : '';
            // 墙上的缩略图按实际显示尺寸 * 设备像素比要图（普通屏 1x 就不用多要 2x 的流量/解码开销，
            // 高分屏封顶在 2x，不然 3x 机型一次性吃满带宽）；转换失败（HEIC 等）就在 onerror 里走浏览器端解码兜底
            const thumbW = Math.round((isMobileLayout ? mobileRenderSize : size) * dpr);
            // 不再传 h= + fit=cover 强制裁成正方形——只限宽，fit=scale-down 按原图比例缩放，不裁内容
            const thumbSrc = p.url.replace('/img/', '/thumb/') + '?w=' + thumbW + '&q=75&fit=scale-down';
            // _roomReactions 的值是 {emoji: count} 对象，直接 > 0 比较恒为 false（之前初次渲染
            // 计数永远空白，全靠 WS init 后 _syncAllCounts 补），要先用 _totalReactions 聚合成数字
            const reactCnt = _totalReactions(p.key);
            const reactCntText = reactCnt > 0 ? reactCnt : '';
            if (p.type === 'video') {
              return `<div class="cell${extraClass}" style="${style}" onclick="openLightbox(${flatIndex}, false)"><div class="frame-inner"><video data-src="${escAttr(p.url)}#t=0.5" muted loop playsinline preload="metadata" onloadeddata="this.classList.add('loaded')" onmouseenter="this.play().catch(()=>{})" onmouseleave="this.pause();this.currentTime=0.5"></video></div><span class="play-badge">▶ 视频</span><span class="frame-year">${y.year}</span><button class="react-btn" data-key="${escAttr(p.key)}" onclick="event.stopPropagation();doReact(this)">❤️<span class="react-cnt">${reactCntText}</span></button></div>`;
            }
            if (p.type === 'live') {
              // Live Photo 缩略图：默认显示静态图，悬浮（桌面）/长按（移动端）才播放配对的短视频
              // 网格缩略图上不展示 Live Photo 图标——放大（点开灯箱）才提示，网格里看起来就是张普通照片，
              // 悬浮照样会播放配对视频，算是个不张扬的小彩蛋
              return `<div class="cell${extraClass}" style="${style}" onclick="openLightbox(${flatIndex}, false)"><div class="frame-inner live-photo-cell" onmouseenter="this.classList.add('playing');const v=this.querySelector('video');v.loop=true;v.currentTime=0;v.play().catch(()=>{})" onmouseleave="this.classList.remove('playing');this.querySelector('video').pause()" ontouchstart="livePhotoTouchStart(this,event)" ontouchend="livePhotoTouchEnd(this,event)" ontouchcancel="livePhotoTouchEnd(this,event)"><img src="${escAttr(thumbSrc)}" data-src="${escAttr(p.url)}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.onerror=null;scheduleImageRetry(this,this.src,this.dataset.src)" /><video src="${p.videoUrl}" loop muted playsinline preload="none" class="cell-live-video"></video></div><span class="frame-year">${y.year}</span><button class="react-btn" data-key="${escAttr(p.key)}" onclick="event.stopPropagation();doReact(this)">❤️<span class="react-cnt">${reactCntText}</span></button></div>`;
            }
            return `<div class="cell${extraClass}" style="${style}" onclick="openLightbox(${flatIndex}, false)"><div class="frame-inner"><img src="${escAttr(thumbSrc)}" data-src="${escAttr(p.url)}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.onerror=null;scheduleImageRetry(this,this.src,this.dataset.src)" /></div><span class="frame-year">${y.year}</span><button class="react-btn" data-key="${escAttr(p.key)}" onclick="event.stopPropagation();doReact(this)">❤️<span class="react-cnt">${reactCntText}</span></button></div>`;
          }).join('');
          const showMoreBtn = extraCount > 0
            ? `<button class="show-more-btn" data-total="${y.photos.length}" onclick="toggleShowMore(this)">展开查看全部 ${y.photos.length} 张 ›</button>`
            : '';
          return `
      <div class="year-block${idPrefix === 'lunar-year-' ? ' lunar-year-block' : ''}" id="${idPrefix}${y.year}">
        <div class="year-title">${y.year} 年 <span class="count">（${y.photos.length} 份）</span></div>
        <div class="grid">${cells}</div>
        ${showMoreBtn}
      </div>
    `;
        };
        const yearPrefix = includeLunarForRequest ? 'lunar-year-' : 'year-';
        content.innerHTML = visibleYears.map(y => renderYearBlock(y, yearPrefix)).join('');
        content.querySelectorAll('.cell').forEach((cell) => cellObserver.observe(cell));
        content.querySelectorAll('.cell video[data-src]').forEach((v) => videoLazyObserver.observe(v));

        // "跳到某一年"下拉菜单：照片加载完才知道有哪些年份，这时候再填充菜单内容、解锁按钮。
        // 菜单必须跟正在展示的年份块（visibleYears/yearPrefix）同一套——农历模式渲染的块
        // id 是 lunar-year-YYYY，之前菜单固定用公历的 data.years + 'year-' 前缀，
        // 农历模式下点年份找不到元素，滚动没反应、份数也是公历的数
        yearToggle.disabled = false;
        yearMenu.innerHTML = visibleYears.map((y, i) =>
          '<button style="animation-delay:' + (i * 0.05) + 's" onclick="jumpToYear(' + y.year + ')"><span class="y">' + y.year + ' 年</span>' +
          '<span class="c">' + y.photos.length + ' 份</span></button>'
        ).join('');
        window.jumpToYear = function (year) {
          const el = document.getElementById(yearPrefix + year);
          if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 24, behavior: 'smooth' });
          yearMenu.classList.remove('open');
        };

        fadeIn();
      };

      // 首屏数据已到、缩略图马上开始加载——再等一小拍才启动背景叶影视频的下载，不抢首屏带宽
      if (isFirst) setTimeout(startLeafVideo, 800);

      // 首次加载（骨架屏是 SSR 直出的）或者确实画出过骨架屏，这时候内容区域当前还显示着骨架屏，
      // 要先淡出再换真实内容；网络够快、上面跳过了骨架屏绘制的情况，内容这时候已经是淡出状态了
      // （进 loadMemories 时就 fadeOut 过一次），不用再多走一轮，直接换内容更快也不会有额外的视觉跳动
      if (isFirst || showedSkeleton) {
        fadeOut().then(() => {
          if (seq !== _memSeq) return;
          apply();
        });
      } else {
        apply();
      }
    }).catch((err) => {
      if (seq !== _memSeq) return; // 已经被新的切换顶替，不用管这次失败
      console.error('loadMemories failed', err);
      if (isFirst) startLeafVideo(); // 数据没加载出来也别让氛围层一起缺席
      const showError = () => {
        subtitle.textContent = '加载失败，请稍后重试';
        content.innerHTML = '<div class="empty">这天的回忆没能加载出来，请检查网络后重试</div>';
        fadeIn();
      };
      if (isFirst || showedSkeleton) {
        fadeOut().then(() => {
          if (seq !== _memSeq) return;
          showError();
        });
      } else {
        showError();
      }
    });
  }
  loadMemories(month, day);