  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

  const mapParams = new URLSearchParams(location.search);
  // 带 month/day 时只看那一天（从"那年今日"跳过来）；不带就是全量足迹地球
  const hasDayFilter = mapParams.has('month') || mapParams.has('day');
  const mapNow = new Date();
  const mapMonth = mapParams.get('month') || String(mapNow.getMonth() + 1).padStart(2, '0');
  const mapDay   = mapParams.get('day')   || String(mapNow.getDate()).padStart(2, '0');

  mapboxgl.accessToken = window.MAPBOX_TOKEN;
  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [105, 30],
    zoom: 1.7,
    projection: 'globe',
  });

  // 地球外的星空 + 大气层光晕
  map.on('style.load', () => {
    map.setFog({
      color: 'rgb(12,12,24)',
      'high-color': 'rgb(32,40,74)',
      'horizon-blend': 0.03,
      'space-color': 'rgb(4,4,12)',
      'star-intensity': 0.35,
    });
  });

  const ICON_CAM = '<svg viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
  const ICON_PIN = '<svg viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  const ICON_ALT = '<svg viewBox="0 0 24 24"><polyline points="3 20 9 12 13 16 17 11 21 20"/></svg>';
  const ICON_CAL = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>';

  let _popup = null;      // 当前打开的弹窗（单张/聚合共用一个位置）
  let _exifAbort = null;  // 详情卡的 EXIF 请求，切换时取消在途的

  function closePopup() {
    if (_popup) { _popup.remove(); _popup = null; }
    if (_exifAbort) { _exifAbort.abort(); _exifAbort = null; }
  }

  // 单天模式的旧缓存响应里可能没有 month/day 字段，用页面参数兜底（本来就是那一天）
  function photoMonth(p) { return p.month || mapMonth; }
  function photoDay(p) { return p.day || mapDay; }
  function fmtDate(p) { return p.year + '年' + parseInt(photoMonth(p)) + '月' + parseInt(photoDay(p)) + '日'; }

  // ── 单张照片详情卡：锚定在标记上（图 + 名称 + 地点·日期 + 设备/坐标/海拔）──────
  function showPhotoPopup(p) {
    closePopup();
    const lat = Number(p.lat), lon = Number(p.lon);
    const name = p.key.split('/').pop().replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    const sub = [p.name, fmtDate(p)].filter(Boolean).join(' · ');
    const coordStr = (lat >= 0 ? '北纬 ' : '南纬 ') + Math.abs(lat).toFixed(4) + '°，'
      + (lon >= 0 ? '东经 ' : '西经 ') + Math.abs(lon).toFixed(4) + '°';
    const dayHref = '/?month=' + photoMonth(p) + '&day=' + photoDay(p);
    const thumb = p.url.replace('/img/', '/thumb/') + '?w=480&h=340&q=80&fit=cover';
    const media = p.type === 'video'
      ? '<video src="' + escAttr(p.url) + '#t=0.5" muted preload="metadata" class="loaded"></video>'
      : '<img src="' + escAttr(thumb) + '" onload="this.classList.add(\'loaded\')" />';

    const html =
      '<a class="pp-media" href="' + dayHref + '" title="去看这一天">' + media + '</a>' +
      '<div class="pp-body">' +
        '<div class="pp-title">' + esc(name) + '</div>' +
        '<div class="pp-sub">' + esc(sub) + '</div>' +
        '<div class="pp-rows" id="ppRows">' +
          '<div class="pp-row">' + ICON_PIN + '<span>' + esc(coordStr) + '</span></div>' +
        '</div>' +
      '</div>';

    _popup = new mapboxgl.Popup({ closeButton: true, maxWidth: 'none', className: 'photo-popup', offset: 16 })
      .setLngLat([lon, lat]).setHTML(html).addTo(map);
    _popup.on('close', () => { if (_exifAbort) { _exifAbort.abort(); _exifAbort = null; } });
    map.easeTo({ center: [lon, lat], offset: [0, -140], duration: 420 });

    // 异步补 EXIF：设备型号 + 海拔
    if (/\.(jpe?g|heic)$/i.test(p.key)) {
      const ctrl = new AbortController();
      _exifAbort = ctrl;
      fetch('/api/exif?key=' + encodeURIComponent(p.key), { signal: ctrl.signal })
        .then(r => r.ok ? r.json() : null)
        .then(exif => {
          _exifAbort = null;
          const rows = document.getElementById('ppRows');
          if (!exif || !rows) return;
          if (exif.make || exif.model) {
            rows.insertAdjacentHTML('afterbegin',
              '<div class="pp-row">' + ICON_CAM + '<span>' + esc([exif.make, exif.model].filter(Boolean).join(' ')) + '</span></div>');
          }
          if (exif.altitude !== undefined) {
            rows.insertAdjacentHTML('beforeend',
              '<div class="pp-row">' + ICON_ALT + '<span>' + esc(exif.altitude.toFixed(1)) + ' 米</span></div>');
          }
        })
        .catch(() => {});
    }
  }

  // ── 聚合弹窗："附近有 N 张照片" + 缩略图九宫格 + 地点 + 时间范围 ────────────────
  function showClusterPopup(coords, total, items) {
    closePopup();
    const place = (items.find(p => p.name) || {}).name || '';
    const sorted = items.slice().sort((a, b) =>
      (a.year + photoMonth(a) + photoDay(a)).localeCompare(b.year + photoMonth(b) + photoDay(b)));
    const first = sorted[0], last = sorted[sorted.length - 1];
    const fmt = (p) => p.year + '/' + parseInt(photoMonth(p)) + '/' + parseInt(photoDay(p));
    const range = fmt(first) + (sorted.length > 1 && fmt(last) !== fmt(first) ? ' – ' + fmt(last) : '');

    const thumbs = items.slice(0, 6).map((p, i) => {
      const t = p.url.replace('/img/', '/thumb/') + '?w=200&h=200&q=70&fit=cover';
      const more = (i === 5 && total > 6) ? '<span class="cp-more">+' + (total - 6) + '</span>' : '';
      return '<div class="cp-thumb" data-i="' + i + '"><img src="' + escAttr(t) + '" loading="lazy" />' + more + '</div>';
    }).join('');

    const html =
      '<div class="cp-head"><span>附近有 ' + total + ' 张照片</span><span class="cp-hint">点击图片查看详情</span></div>' +
      '<div class="cp-grid">' + thumbs + '</div>' +
      (place ? '<div class="cp-meta">' + ICON_PIN + '<span>' + esc(place) + '</span></div>' : '') +
      '<div class="cp-meta">' + ICON_CAL + '<span>' + esc(range) + '</span></div>';

    _popup = new mapboxgl.Popup({ closeButton: true, maxWidth: 'none', className: 'cluster-popup', offset: 20 })
      .setLngLat(coords).setHTML(html).addTo(map);
    _popup.getElement().addEventListener('click', (ev) => {
      const th = ev.target.closest('.cp-thumb');
      if (!th) return;
      showPhotoPopup(items[Number(th.dataset.i)]);
    });
  }

  // ── 加载照片 + 聚合图层 ───────────────────────────────────────────────────────
  const apiUrl = hasDayFilter ? '/api/map-photos?month=' + mapMonth + '&day=' + mapDay : '/api/map-photos';

  map.on('load', () => {
    fetch(apiUrl)
      .then(r => r.json())
      .then(data => {
        const photos = data.photos || [];
        if (!photos.length) {
          document.getElementById('mapEmpty').style.display = 'block';
          return;
        }

        map.addSource('photos', {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: photos.map(p => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
              properties: p,
            })),
          },
          cluster: true,
          clusterMaxZoom: 15,
          clusterRadius: 52,
        });

        // 聚合圈：深色圆 + 白描边 + 数字
        map.addLayer({
          id: 'clusters', type: 'circle', source: 'photos',
          filter: ['has', 'point_count'],
          paint: {
            'circle-color': 'rgba(22,22,30,0.88)',
            'circle-radius': ['step', ['get', 'point_count'], 17, 10, 21, 30, 26, 100, 31],
            'circle-stroke-width': 1.6,
            'circle-stroke-color': 'rgba(255,255,255,0.85)',
          },
        });
        map.addLayer({
          id: 'cluster-count', type: 'symbol', source: 'photos',
          filter: ['has', 'point_count'],
          layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-size': 12,
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          },
          paint: { 'text-color': '#ffffff' },
        });
        // 单张：粉色光点（外圈柔光 + 实心点）
        map.addLayer({
          id: 'photo-glow', type: 'circle', source: 'photos',
          filter: ['!', ['has', 'point_count']],
          paint: { 'circle-color': 'rgba(232,96,122,0.35)', 'circle-radius': 15, 'circle-blur': 0.7 },
        });
        map.addLayer({
          id: 'photo-point', type: 'circle', source: 'photos',
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': '#e8607a',
            'circle-radius': 8,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        });

        // 单张点击 → 详情卡
        map.on('click', 'photo-point', (e) => {
          showPhotoPopup(e.features[0].properties);
        });
        // 聚合点击 → 照片组弹窗；双击 → 放大展开
        map.on('click', 'clusters', (e) => {
          const f = e.features[0];
          map.getSource('photos').getClusterLeaves(f.properties.cluster_id, 24, 0, (err, leaves) => {
            if (err) return;
            showClusterPopup(f.geometry.coordinates, f.properties.point_count, leaves.map(l => l.properties));
          });
        });
        map.on('dblclick', 'clusters', (e) => {
          e.preventDefault();
          const f = e.features[0];
          map.getSource('photos').getClusterExpansionZoom(f.properties.cluster_id, (err, zoom) => {
            if (err) return;
            map.easeTo({ center: f.geometry.coordinates, zoom: zoom + 0.3, duration: 500 });
          });
        });

        // 空白处点击关弹窗
        map.on('click', (e) => {
          const fs = map.queryRenderedFeatures(e.point, { layers: ['clusters', 'photo-point'] });
          if (!fs.length) closePopup();
        });
        ['clusters', 'photo-point'].forEach((layer) => {
          map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
          map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
        });

        // 视野：单天模式贴近看；全量模式收进所有点但保持地球感
        let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
        photos.forEach(p => {
          minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
          minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
        });
        if (photos.length === 1) {
          map.jumpTo({ center: [photos[0].lon, photos[0].lat], zoom: 9 });
        } else {
          map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
            padding: 80,
            maxZoom: hasDayFilter ? 12 : 4.5,
          });
        }
      });
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });
