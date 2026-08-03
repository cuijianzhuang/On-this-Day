  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

  const mapParams = new URLSearchParams(location.search);
  // 带 month/day 时只看那一天（从"那年今日"跳过来）；不带就是全量足迹地球
  const hasDayFilter = mapParams.has('month') || mapParams.has('day');
  const mapNow = new Date();
  const mapMonth = mapParams.get('month') || String(mapNow.getMonth() + 1).padStart(2, '0');
  const mapDay   = mapParams.get('day')   || String(mapNow.getDate()).padStart(2, '0');
  const mapYear  = mapParams.get('year') || '';       // 只在全量模式下生效：只播放某一年的足迹
  const autoTrail = mapParams.get('trail') === '1';   // 从 Recap 页跳过来时自动开始播放

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

  let _popup = null;
  let _exifAbort = null;
  // hover 交互状态：鼠标在标记上或在弹窗上时保持弹窗，移开后 200ms 无交互才关闭
  let _hoverActive = false;
  let _closeTimer = null;
  let _popupTracked = false;   // 弹窗 mouseenter/leave 只绑一次
  let _clusterItems = null;    // 聚合弹窗当前条目，click handler 通过此引用取值
  let _clusterLoadId = 0;      // 防止旧请求覆盖新弹窗

  function closePopup() {
    clearTimeout(_closeTimer);
    if (_popup) { _popup.remove(); _popup = null; }
    if (_exifAbort) { _exifAbort.abort(); _exifAbort = null; }
    _popupTracked = false;
    _clusterItems = null;
  }

  function scheduleClose() {
    clearTimeout(_closeTimer);
    _closeTimer = setTimeout(() => { if (!_hoverActive) closePopup(); }, 200);
  }

  // 让弹窗本身也能阻止关闭：鼠标移进弹窗视为"仍在交互"
  function trackPopupHover() {
    if (!_popup || _popupTracked) return;
    _popupTracked = true;
    const el = _popup.getElement();
    el.addEventListener('mouseenter', () => { _hoverActive = true; clearTimeout(_closeTimer); });
    el.addEventListener('mouseleave', () => { _hoverActive = false; scheduleClose(); });
  }

  // 单天模式的旧缓存响应里可能没有 month/day 字段，用页面参数兜底（本来就是那一天）
  function photoMonth(p) { return p.month || mapMonth; }
  function photoDay(p) { return p.day || mapDay; }
  function fmtDate(p) { return p.year + '年' + parseInt(photoMonth(p)) + '月' + parseInt(photoDay(p)) + '日'; }

  // ── 单张照片详情卡 ──────────────────────────────────────────────────────────
  // navigate=true 时地图平移到照片位置（点击时），hover 时不平移避免视图跳动
  function showPhotoPopup(p, { navigate = false } = {}) {
    closePopup();
    const lat = Number(p.lat), lon = Number(p.lon);
    const name = p.key.split('/').pop().replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    const sub = [p.name, fmtDate(p)].filter(Boolean).join(' · ');
    const coordStr = lat.toFixed(4) + '°' + (lat >= 0 ? 'N' : 'S') + '，'
      + lon.toFixed(4) + '°' + (lon >= 0 ? 'E' : 'W');
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
    trackPopupHover();
    if (navigate) map.easeTo({ center: [lon, lat], offset: [0, -140], duration: 420 });

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
              '<div class="pp-row">' + ICON_ALT + '<span>' + esc(exif.altitude.toFixed(1)) + 'm</span></div>');
          }
        })
        .catch(() => {});
    }
  }

  // ── 聚合弹窗 HTML 构建 ──────────────────────────────────────────────────────
  function buildClusterHTML(total, items) {
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

    return (
      '<div class="cp-head"><span>附近有 ' + total + ' 张照片</span><span class="cp-hint">点击图片查看详情</span></div>' +
      '<div class="cp-grid">' + thumbs + '</div>' +
      (place ? '<div class="cp-meta">' + ICON_PIN + '<span>' + esc(place) + '</span></div>' : '') +
      '<div class="cp-meta">' + ICON_CAL + '<span>' + esc(range) + '</span></div>'
    );
  }

  function buildClusterLoadingHTML(total) {
    return (
      '<div class="cp-head"><span>附近有 ' + total + ' 张照片</span></div>' +
      '<div class="cp-loading">' +
        '<svg class="cp-spinner" viewBox="0 0 50 50" fill="none">' +
          '<circle cx="25" cy="25" r="20" stroke="rgba(255,255,255,0.15)" stroke-width="4"/>' +
          '<circle cx="25" cy="25" r="20" stroke="rgba(255,255,255,0.7)" stroke-width="4"' +
          ' stroke-dasharray="60 66" stroke-linecap="round"/>' +
        '</svg>' +
      '</div>'
    );
  }

  // ── 加载照片 + 聚合图层 ───────────────────────────────────────────────────────
  const apiUrl = hasDayFilter
    ? '/api/map-photos?month=' + mapMonth + '&day=' + mapDay
    : '/api/map-photos' + (mapYear ? '?year=' + encodeURIComponent(mapYear) : '');

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

        // ── 聚合圈 hover：立即弹出加载状态，异步填充缩略图 ─────────────────
        map.on('mouseenter', 'clusters', (e) => {
          map.getCanvas().style.cursor = 'pointer';
          _hoverActive = true;
          clearTimeout(_closeTimer);
          const f = e.features[0];
          const coords = f.geometry.coordinates;
          const total = f.properties.point_count;
          const clusterId = f.properties.cluster_id;
          const myLoadId = ++_clusterLoadId;

          // 立即弹出加载占位
          closePopup();
          _popup = new mapboxgl.Popup({
            closeButton: true, maxWidth: 'none',
            className: 'cluster-popup cluster-popup--loading', offset: 20,
          })
            .setLngLat(coords)
            .setHTML(buildClusterLoadingHTML(total))
            .addTo(map);
          // 聚合弹窗点击（用事件委托，_clusterItems 后续更新后自动生效）
          _popup.getElement().addEventListener('click', (ev) => {
            const th = ev.target.closest('.cp-thumb');
            if (!th || !_clusterItems) return;
            showPhotoPopup(_clusterItems[Number(th.dataset.i)], { navigate: true });
          });
          trackPopupHover();

          // 异步获取叶子节点，更新弹窗内容
          map.getSource('photos').getClusterLeaves(clusterId, 24, 0, (err, leaves) => {
            if (err || myLoadId !== _clusterLoadId || !_popup) return;
            _clusterItems = leaves.map(l => l.properties);
            _popup.setHTML(buildClusterHTML(total, _clusterItems));
            _popup.getElement().classList.remove('cluster-popup--loading');
          });
        });

        map.on('mouseleave', 'clusters', () => {
          map.getCanvas().style.cursor = '';
          _hoverActive = false;
          scheduleClose();
        });

        // ── 单张点 hover：立即弹出详情卡（不平移地图）────────────────────
        map.on('mouseenter', 'photo-point', (e) => {
          map.getCanvas().style.cursor = 'pointer';
          _hoverActive = true;
          clearTimeout(_closeTimer);
          showPhotoPopup(e.features[0].properties);
        });

        map.on('mouseleave', 'photo-point', () => {
          map.getCanvas().style.cursor = '';
          _hoverActive = false;
          scheduleClose();
        });

        // 点击：聚合双击展开；单张点击平移地图
        map.on('click', 'photo-point', (e) => {
          showPhotoPopup(e.features[0].properties, { navigate: true });
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

        // 轨迹回放只在全量模式下开放：/api/map-photos 已经按拍摄日期升序排好了，
        // 这里只需要按距离把连续的点聚成"停留点"，避免同一次旅行几十张照片飞几十次
        if (!hasDayFilter) setupTrail(photos);
      });
  });

  // ── 轨迹回放：按时间顺序依次飞向每个停留点，画一条渐显的轨迹线 ─────────────────
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  const TRAIL_STOP_KM = 15; // 同一次停留内的照片彼此距离阈值，超过判定为下一个停留点
  // 只画最近几个停留点之间的连线（"彗星尾巴"），不画从头到尾的完整轨迹——家庭相册的
  // 拍摄地点通常绝大部分集中在常住城市，偶尔才有几次出行，如果把整段历史的连线都摞在一起，
  // 每次"回家"都会在同一片区域再画一条线，越播放线越多，最后叠成一团乱麻，完全看不出方向
  const TRAIL_WINDOW = 5;

  let _trailStops = [];
  let _trailIdx = 0;
  let _trailPlaying = false;
  let _trailTimer = null;

  function setupTrail(photos) {
    const stops = [];
    for (const p of photos) {
      const last = stops[stops.length - 1];
      if (last && haversineKm(last.lat, last.lon, p.lat, p.lon) < TRAIL_STOP_KM) {
        last.photos.push(p);
      } else {
        stops.push({ lat: p.lat, lon: p.lon, year: p.year, name: p.name, photos: [p] });
      }
    }
    _trailStops = stops;
    document.getElementById('trailBtn').hidden = stops.length < 2;

    // lineMetrics 开启后可以用 line-progress 表达式做渐变——尾部（旧）透明，头部（新）不透明，
    // 视觉上是一条正在消失的彗星尾巴，而不是一条实心线段
    map.addSource('trail-line', {
      type: 'geojson', lineMetrics: true,
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
    });
    const gradient = ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(232,96,122,0)', 1, 'rgba(232,96,122,0.9)'];
    map.addLayer({
      id: 'trail-glow', type: 'line', source: 'trail-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': 8, 'line-blur': 4, 'line-gradient': gradient },
    });
    map.addLayer({
      id: 'trail-line', type: 'line', source: 'trail-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': 2, 'line-gradient': gradient },
    });

    if (autoTrail && stops.length >= 2) startTrail();
  }

  function updateTrailLine() {
    const start = Math.max(0, _trailIdx - TRAIL_WINDOW + 1);
    const coords = _trailStops.slice(start, _trailIdx + 1).map(s => [s.lon, s.lat]);
    // line-gradient 要求至少两个点才能画出有意义的渐变，只有一个点时给空线，等下一站再显示
    map.getSource('trail-line').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords.length >= 2 ? coords : [] },
    });
  }

  function trailStopLabel(stop) {
    return [stop.year + ' 年', stop.name].filter(Boolean).join(' · ');
  }

  function playNextStop() {
    if (!_trailPlaying) return;
    if (_trailIdx >= _trailStops.length) { stopTrail(); return; }
    const stop = _trailStops[_trailIdx];
    closePopup();
    map.flyTo({ center: [stop.lon, stop.lat], zoom: mapYear ? 8 : 4.2, duration: 1600, essential: true });
    updateTrailLine();
    document.getElementById('trailDate').textContent = trailStopLabel(stop);
    document.getElementById('trailFill').style.width = (100 * (_trailIdx + 1) / _trailStops.length) + '%';
    _trailTimer = setTimeout(() => { _trailIdx++; playNextStop(); }, 2600);
  }

  function startTrail() {
    if (!_trailStops.length) return;
    _trailPlaying = true;
    document.getElementById('trailBar').hidden = false;
    document.querySelector('.tp-pause').hidden = false;
    document.querySelector('.tp-play').hidden = true;
    playNextStop();
  }

  function pauseTrail() {
    _trailPlaying = false;
    clearTimeout(_trailTimer);
    document.querySelector('.tp-pause').hidden = true;
    document.querySelector('.tp-play').hidden = false;
  }

  function stopTrail() {
    _trailPlaying = false;
    clearTimeout(_trailTimer);
    _trailIdx = 0;
    document.getElementById('trailBar').hidden = true;
  }

  document.getElementById('trailBtn').addEventListener('click', () => {
    _trailIdx = 0;
    startTrail();
  });
  document.getElementById('trailPlayPause').addEventListener('click', () => {
    if (_trailPlaying) pauseTrail();
    else { _trailPlaying = true; document.querySelector('.tp-pause').hidden = false; document.querySelector('.tp-play').hidden = true; playNextStop(); }
  });
  document.getElementById('trailClose').addEventListener('click', stopTrail);

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePopup(); stopTrail(); } });
