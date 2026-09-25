// 边缘缓存（Workers Cache API）的读写。每个 handler 的用法都是两步：
//
//   const hit = await cacheLookup(key);
//   if (hit) return hit;
//   ...算出 response...
//   return cacheStore(ctx, key, response);
//
// 集中在这里是为了统一三件事：
//
// 1. 写缓存不阻塞响应。之前 17 处都是 `await cache.put(...)`：缓存未命中时，用户要等缓存
//    写完才拿到响应。/img/ 更糟——它 clone() 了 R2 的流再 await 写缓存，等于整个原图读完、
//    写进缓存之后才返回第一个字节。放进 ctx.waitUntil 以后，两路流并行读，响应立刻开始返回。
//
// 2. 写缓存失败不连累响应。cache.put 会因为各种内部限制抛错（大文件、某些响应头），
//    边缘缓存只是优化，存不进去就算了，不该让这次请求 500。
//
// 3. 响应带 x-edge-cache: HIT / MISS。缓存到底有没有生效，浏览器 DevTools 里一眼就能看到。
//    （Cloudflare 文档说"被 Cloudflare Access 挡在前面的 Worker 不能用 Cache API"，
//    本站是自定义域名 + Access，按文档大概率不受影响，但措辞有歧义——这个头就是用来确认的。）

export async function cacheLookup(key) {
  const hit = await caches.default.match(new Request(key));
  return hit ? withCacheStatus(hit, "HIT") : null;
}

// 只缓存 200：错误、204 空响应、206 分段、重定向都不进缓存（Cache API 也不收 206）
export async function cacheStore(ctx, key, response) {
  if (response.status !== 200) return response;
  await cachePut(ctx, key, response);
  return withCacheStatus(response, "MISS");
}

// 不管状态码、直接写一份进缓存（调用方自己决定该不该存，比如 /thumb/ 的 302 重定向）。
// 不阻塞、不抛错。传进来的 response 会被 clone，调用方之后照常返回它即可
export async function cachePut(ctx, key, response) {
  const put = caches.default
    .put(new Request(key), response.clone())
    .catch((err) => console.error("cache.put failed for", key, err));
  // 没有 ctx 就只能等它写完——响应返回后，没交给 waitUntil 的异步任务可能被运行时直接取消
  if (ctx) ctx.waitUntil(put);
  else await put;
}

function withCacheStatus(response, status) {
  const tagged = new Response(response.body, response);
  tagged.headers.set("x-edge-cache", status);
  return tagged;
}
