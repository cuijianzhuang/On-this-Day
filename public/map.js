  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

  window.heicFallback = async function (imgEl, originalUrl) {
    if (!/\.heic$/i.test(originalUrl)) { imgEl.src = originalUrl; return; }
    try {
      const resp = await fetch(originalUrl);
      const blob = await resp.blob();
      const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.85 });
      const previewBlob = Array.isArray(converted) ? converted[0] : converted;
      imgEl.src = URL.createObjectURL(previewBlob);
      const heicKey = originalUrl.replace('/img/', '');
      fetch('/api/upload-heic-preview?key=' + heicKey, { method: 'POST', body: previewBlob }).catch(() => {});
    } catch {}
  };

  const mapParams = new URLSearchParams(location.search);
  const mapNow = new Date();
  const mapMonth = mapParams.get('month') || String(mapNow.getMonth() + 1).padStart(2, '0');
  const mapDay   = mapParams.get('day')   || String(mapNow.getDate()).padStart(2, '0');

  mapboxgl.accessToken = window.MAPBOX_TOKEN;
  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [108, 34],
    zoom: 2.4,
  });

  // ── 底部卡片 DOM ─────────────────────────────────────────────────────────────
  const cardEl     = document.getElementById('mapCard');
  const cardMedia  = document.getElementById('cardMedia');
  const cardInfo   = document.getElementById('cardInfo');
  const cardClose  = document.getElementById('cardClose');
  const overlayEl  = document.getElementById('mapOverlay');

  let activeMarkerEl = null;
  let _mapExifAbort = null;

  // ── 卡片照片缩放 + 平移 ──────────────────────────────────────────────────────
  let _cs = 1, _ctx = 0, _cty = 0;
  let _cpanning = false, _cpsx = 0, _cpsy = 0, _cptx0 = 0, _cpty0 = 0;
  let _clastTap = 0;

  function _cTarget() { return cardMedia.querySelector('img, video'); }

  function _cClamp() {
    if (_cs <= 1) return;
    const mw = cardMedia.offsetWidth, mh = cardMedia.offsetHeight;
    const mx = mw * (_cs - 1) / 2, my = mh * (_cs - 1) / 2;
    _ctx = Math.max(-mx, Math.min(mx, _ctx));
    _cty = Math.max(-my, Math.min(my, _cty));
  }

  function _cApply() {
    const t = _cTarget();
    if (!t) return;
    t.style.transform = _cs === 1 ? '' : `translate(${_ctx}px,${_cty}px) scale(${_cs})`;
    cardMedia.classList.toggle('zoomed', _cs > 1);
  }

  function _cReset() {
    _cs = 1; _ctx = 0; _cty = 0; _cpanning = false;
    cardMedia.classList.remove('panning');
    _cApply();
  }

  cardMedia.addEventListener('wheel', (e) => {
    e.preventDefault();
    const t = _cTarget();
    if (!t) return;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const oldS = _cs;
    const newS = Math.max(1, Math.min(8, oldS * factor));
    if (newS === oldS) return;
    const rect = cardMedia.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const r = newS / oldS;
    _ctx = _ctx * r + cx * (1 - r);
    _cty = _cty * r + cy * (1 - r);
    _cs = newS;
    if (_cs <= 1) { _cs = 1; _ctx = 0; _cty = 0; }
    _cClamp();
    _cApply();
  }, { passive: false });

  cardMedia.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (_cs > 1) { _cReset(); return; }
    const rect = cardMedia.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    _cs = 2.5;
    _ctx = cx * (1 - _cs);
    _cty = cy * (1 - _cs);
    _cClamp();
    _cApply();
  });

  cardMedia.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || _cs <= 1) return;
    e.stopPropagation();
    _cpanning = true;
    cardMedia.setPointerCapture(e.pointerId);
    cardMedia.classList.add('panning');
    _cpsx = e.clientX; _cpsy = e.clientY;
    _cptx0 = _ctx; _cpty0 = _cty;
  });

  cardMedia.addEventListener('pointermove', (e) => {
    if (!_cpanning) return;
    _ctx = _cptx0 + e.clientX - _cpsx;
    _cty = _cpty0 + e.clientY - _cpsy;
    _cClamp();
    _cApply();
  });

  const _cEndPan = () => {
    if (!_cpanning) return;
    _cpanning = false;
    cardMedia.classList.remove('panning');
  };
  cardMedia.addEventListener('pointerup', _cEndPan);
  cardMedia.addEventListener('pointercancel', _cEndPan);

  // 移动端双击（双击 tap）缩放
  cardMedia.addEventListener('touchend', (e) => {
    if (_cpanning) return;
    if (e.changedTouches.length === 1) {
      const now = Date.now();
      if (now - _clastTap < 280) {
        e.preventDefault();
        if (_cs > 1) { _cReset(); }
        else {
          const touch = e.changedTouches[0];
          const rect = cardMedia.getBoundingClientRect();
          const cx = touch.clientX - rect.left - rect.width / 2;
          const cy = touch.clientY - rect.top - rect.height / 2;
          _cs = 2.5;
          _ctx = cx * (1 - _cs);
          _cty = cy * (1 - _cs);
          _cClamp();
          _cApply();
        }
      }
      _clastTap = now;
    }
  });

  // 移动端放大后单指平移
  cardMedia.addEventListener('touchstart', (e) => {
    if (_cs > 1 && e.touches.length === 1) {
      e.preventDefault();
      _cpanning = true;
      cardMedia.classList.add('panning');
      _cpsx = e.touches[0].clientX; _cpsy = e.touches[0].clientY;
      _cptx0 = _ctx; _cpty0 = _cty;
    }
  }, { passive: false });
  cardMedia.addEventListener('touchmove', (e) => {
    if (_cpanning && e.touches.length === 1) {
      e.preventDefault();
      _ctx = _cptx0 + e.touches[0].clientX - _cpsx;
      _cty = _cpty0 + e.touches[0].clientY - _cpsy;
      _cClamp();
      _cApply();
    }
  }, { passive: false });
  cardMedia.addEventListener('touchend', () => {
    if (_cpanning) { _cpanning = false; cardMedia.classList.remove('panning'); }
  });

  // ── 开关卡片 ─────────────────────────────────────────────────────────────────
  function closeCard() {
    cardEl.classList.remove('open');
    overlayEl.classList.remove('visible');
    if (activeMarkerEl) { activeMarkerEl.classList.remove('active'); activeMarkerEl = null; }
    if (_mapExifAbort) { _mapExifAbort.abort(); _mapExifAbort = null; }
    _cReset();
    cardMedia.innerHTML = '';
    cardInfo.innerHTML = '';
  }

  cardClose.onclick = closeCard;
  overlayEl.onclick = closeCard;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCard(); });

  function openCard(p, markerEl) {
    if (activeMarkerEl) activeMarkerEl.classList.remove('active');
    activeMarkerEl = markerEl;
    markerEl.classList.add('active');
    _cReset();

    const thumbSrc = p.url.replace('/img/', '/thumb/') + '?w=800&h=560&q=82&fit=cover';
    const filename = p.key.split('/').pop().replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    const dateStr  = `${p.year}年${parseInt(mapMonth)}月${parseInt(mapDay)}日`;
    const subtitle = [p.name, dateStr].filter(Boolean).join(' · ');
    const coordStr = `北纬 ${Math.abs(p.lat).toFixed(4)}°，${p.lon >= 0 ? '东经' : '西经'} ${Math.abs(p.lon).toFixed(4)}°`;

    const ICON_CAM = `<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
    const ICON_PIN = `<svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
    const ICON_ALT = `<svg viewBox="0 0 24 24"><polyline points="3 20 9 12 13 16 17 11 21 20"/></svg>`;

    cardMedia.innerHTML = p.type === 'video'
      ? `<video class="loaded" src="${escAttr(p.url)}#t=0.5" muted preload="metadata"></video>`
      : `<img src="${escAttr(thumbSrc)}" data-src="${escAttr(p.url)}" onload="this.classList.add('loaded')" onerror="this.onerror=null;heicFallback(this,this.dataset.src)" />`;

    cardInfo.innerHTML = `
      <div class="card-title">${esc(filename)}</div>
      <div class="card-subtitle">${esc(subtitle)}</div>
      <div class="card-rows">
        <div class="card-row">
          <span class="card-row-icon">${ICON_PIN}</span>
          <span class="card-row-text">${esc(coordStr)}</span>
        </div>
      </div>`;

    cardEl.classList.add('open');
    overlayEl.classList.add('visible');

    // 异步加载 EXIF：设备型号 + 海拔
    if (_mapExifAbort) { _mapExifAbort.abort(); _mapExifAbort = null; }
    if (/\.(jpe?g|heic)$/i.test(p.key)) {
      const exifCtrl = new AbortController();
      _mapExifAbort = exifCtrl;
      fetch('/api/exif?key=' + encodeURIComponent(p.key), { signal: exifCtrl.signal })
        .then(r => r.ok ? r.json() : null)
        .then(exif => {
          _mapExifAbort = null;
          if (!exif || !cardInfo.querySelector('.card-rows')) return;
          const rowsEl = cardInfo.querySelector('.card-rows');
          if (exif.make || exif.model) {
            const row = document.createElement('div');
            row.className = 'card-row';
            row.innerHTML = `<span class="card-row-icon">${ICON_CAM}</span><span class="card-row-text">${esc([exif.make, exif.model].filter(Boolean).join(' '))}</span>`;
            rowsEl.insertBefore(row, rowsEl.firstChild);
          }
          if (exif.altitude !== undefined) {
            const row = document.createElement('div');
            row.className = 'card-row';
            row.innerHTML = `<span class="card-row-icon">${ICON_ALT}</span><span class="card-row-text">${esc(exif.altitude.toFixed(1))} 米</span>`;
            rowsEl.appendChild(row);
          }
        })
        .catch(err => { if (err.name !== 'AbortError') console.error('EXIF fetch failed', err); });
    }
  }

  // ── 加载照片打点 ─────────────────────────────────────────────────────────────
  fetch('/api/map-photos?month=' + mapMonth + '&day=' + mapDay)
    .then(r => r.json())
    .then(data => {
      const photos = data.photos || [];
      if (photos.length === 0) {
        document.getElementById('mapEmpty').style.display = 'block';
        return;
      }

      let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
      photos.forEach(p => {
        minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);

        const el = document.createElement('div');
        el.className = 'map-marker';
        // 相机图标（实心 white）
        el.innerHTML = `<svg viewBox="0 0 24 24" fill="white"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4" fill="#e8607a" stroke="white" stroke-width="1.5"/></svg>`;
        new mapboxgl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);

        el.addEventListener('click', (e) => {
          e.stopPropagation();
          openCard(p, el);
          map.easeTo({ center: [p.lon, p.lat], offset: [0, -80], duration: 400 });
        });
      });

      map.on('click', closeCard);

      if (photos.length === 1) {
        map.jumpTo({ center: [photos[0].lon, photos[0].lat], zoom: 9 });
      } else {
        map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 60, maxZoom: 12 });
      }
    });
