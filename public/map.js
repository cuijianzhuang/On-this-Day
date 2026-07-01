  // 拼 HTML 字符串时用来转义属性值，避免文件名/路径里万一带了引号之类的字符把属性或内嵌脚本弄断
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

  // 缩放失败时的兜底：非 HEIC 文件直接换成原图（浏览器本来就能显示），
  // 只有 HEIC 才需要在浏览器里用 heic2any 现场解码
  window.heicFallback = async function (imgEl, originalUrl) {
    if (!/\.heic$/i.test(originalUrl)) {
      imgEl.src = originalUrl;
      return;
    }
    try {
      const resp = await fetch(originalUrl);
      const blob = await resp.blob();
      const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.85 });
      const previewBlob = Array.isArray(converted) ? converted[0] : converted;
      imgEl.src = URL.createObjectURL(previewBlob);
      // 顺手把现场解码的结果回传存进 PREVIEWS 桶，下次别的访问者就不用再解码一遍了
      const heicKey = originalUrl.replace('/img/', '');
      fetch('/api/upload-heic-preview?key=' + heicKey, { method: 'POST', body: previewBlob }).catch(() => {});
    } catch {
      // 实在解不出来就放弃
    }
  };

  // 跟主页一样，month/day 由前端按本地时间传入，避免 Worker 跑在 UTC 算错"今天"；
  // 没带参数时默认今天，地图只展示这一天匹配到的照片，不是整个照片库
  const mapParams = new URLSearchParams(location.search);
  const mapNow = new Date();
  const mapMonth = mapParams.get('month') || String(mapNow.getMonth() + 1).padStart(2, '0');
  const mapDay = mapParams.get('day') || String(mapNow.getDate()).padStart(2, '0');

  mapboxgl.accessToken = window.MAPBOX_TOKEN;
  const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11',
    center: [108, 34],
    zoom: 2.4,
  });

  fetch('/api/map-photos?month=' + mapMonth + '&day=' + mapDay).then(r => r.json()).then(data => {
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
      el.style.width = '14px';
      el.style.height = '14px';
      el.style.borderRadius = '50%';
      el.style.background = '#ff8f7e';
      el.style.boxShadow = '0 0 0 3px rgba(255,143,126,0.3), 0 2px 6px rgba(0,0,0,0.5)';
      el.style.cursor = 'pointer';

      // 鼠标移上去就展示照片，不用再点一下；移开自动收起。缩略图走 Cloudflare Images binding 要小图
      // 视频不能走 /thumb/（Images binding 不支持视频输入，转换会失败兜底回原始视频字节，套进 <img> 只会裂图），
      // 直接用 <video> 标签播放原始文件取第一帧
      // 原图地址放进 data-src 属性，onerror 只读属性、不直接拼 JS 字符串，文件名里有特殊字符也不会把内嵌脚本弄断
      const popupThumbSrc = p.url.replace('/img/', '/thumb/') + '?w=360&h=360&q=75&fit=cover';
      // 用反引号拼，里面随便写单引号不用转义——这一段本身又被包在 worker.js 外层的反引号模板字符串里，
      // 之前用单引号拼字符串再写 \\'loaded\\' 转义，外层模板字符串会先把这个转义吃掉变成裸的单引号，
      // 提前把发到客户端的字符串截断，导致一上线点开地图就直接报 SyntaxError
      const popupMedia = p.type === 'video'
        ? \`<video class="popup-photo loaded" src="\${escAttr(p.url)}#t=0.5" muted preload="metadata"></video>\`
        : \`<img class="popup-photo" src="\${escAttr(popupThumbSrc)}" data-src="\${escAttr(p.url)}" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.onerror=null;heicFallback(this,this.dataset.src)" />\`;
      const popup = new mapboxgl.Popup({ offset: 14, maxWidth: '200px', closeButton: false, closeOnClick: false }).setHTML(
        popupMedia +
        '<div class="popup-caption">' + (p.year || '') + (p.name ? ' · ' + p.name : '') + '</div>'
      );
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
      el.addEventListener('mouseenter', () => popup.setLngLat([p.lon, p.lat]).addTo(map));
      el.addEventListener('mouseleave', () => popup.remove());
    });

    if (photos.length === 1) {
      map.jumpTo({ center: [photos[0].lon, photos[0].lat], zoom: 9 });
    } else {
      map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 60, maxZoom: 12 });
    }
  });