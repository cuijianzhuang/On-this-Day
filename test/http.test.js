import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cacheLookup, cacheStore, cachePut } from "../src/http.js";

// 内存版 caches.default，只实现 match / put
let store, putCalls;
function installFakeCache({ putImpl } = {}) {
  store = new Map();
  putCalls = 0;
  globalThis.caches = {
    default: {
      async match(req) {
        const e = store.get(req.url);
        return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined;
      },
      async put(req, resp) {
        putCalls++;
        if (putImpl) return putImpl(req, resp);
        store.set(req.url, { body: await resp.text(), status: resp.status, headers: [...resp.headers] });
      },
    },
  };
}
const fakeCtx = () => { const pending = []; return { pending, waitUntil: (p) => pending.push(p) }; };
const KEY = "https://example.test/api/thing?a=1";

beforeEach(() => installFakeCache());

test("未命中时 cacheLookup 返回 null", async () => {
  assert.equal(await cacheLookup(KEY), null);
});

test("写入后再查：命中，内容一致，并带 x-edge-cache: HIT", async () => {
  const ctx = fakeCtx();
  const miss = await cacheStore(ctx, KEY, new Response('{"n":1}', { headers: { "cache-control": "public, max-age=60" } }));
  assert.equal(miss.headers.get("x-edge-cache"), "MISS");
  assert.equal(await miss.text(), '{"n":1}');
  await Promise.all(ctx.pending);

  const hit = await cacheLookup(KEY);
  assert.equal(hit.headers.get("x-edge-cache"), "HIT");
  assert.equal(hit.headers.get("cache-control"), "public, max-age=60");
  assert.equal(await hit.text(), '{"n":1}');
});

test("缓存里存的是原始响应，不带 x-edge-cache 头（否则命中时会读到陈旧的 MISS）", async () => {
  const ctx = fakeCtx();
  await cacheStore(ctx, KEY, new Response("x"));
  await Promise.all(ctx.pending);
  const stored = store.get(KEY);
  assert.ok(!stored.headers.some(([k]) => k === "x-edge-cache"));
});

test("写缓存交给 ctx.waitUntil，不阻塞响应返回", async () => {
  let release;
  installFakeCache({ putImpl: () => new Promise((r) => (release = r)) }); // 一个永远不自己结束的写入
  const ctx = fakeCtx();
  const resp = await cacheStore(ctx, KEY, new Response("body"));
  // 写入还挂着，响应已经拿到了
  assert.equal(await resp.text(), "body");
  assert.equal(ctx.pending.length, 1);
  release();
  await Promise.all(ctx.pending);
});

test("没有 ctx 时等写完再返回（否则写入可能被运行时取消）", async () => {
  const resp = await cacheStore(undefined, KEY, new Response("body"));
  assert.equal(await resp.text(), "body");
  assert.ok(store.has(KEY), "返回时应已写入");
});

test("只缓存 200：错误、204、重定向原样返回，不写缓存", async () => {
  for (const r of [new Response("no", { status: 400 }), new Response(null, { status: 204 }),
                   new Response("gone", { status: 404 }), new Response(null, { status: 302, headers: { location: "/x" } })]) {
    const out = await cacheStore(fakeCtx(), KEY, r);
    assert.equal(out, r, `status ${r.status} 应原样返回`);
    assert.equal(out.headers.get("x-edge-cache"), null);
  }
  assert.equal(putCalls, 0);
});

test("cache.put 抛错不影响响应本身（边缘缓存只是优化）", async () => {
  installFakeCache({ putImpl: async () => { throw new Error("Cache API internal limit"); } });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    const ctx = fakeCtx();
    const resp = await cacheStore(ctx, KEY, new Response("still fine"));
    await Promise.all(ctx.pending); // waitUntil 里的 promise 不能 reject，否则运行时会记一条未处理异常
    assert.equal(await resp.text(), "still fine");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /cache\.put failed/);
  } finally {
    console.error = orig;
  }
});

test("流式响应体：客户端和缓存各读到完整内容", async () => {
  const bytes = new Uint8Array(200_000).map((_, i) => i & 255);
  const stream = new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += 16384) c.enqueue(bytes.slice(i, i + 16384)); c.close(); },
  });
  let cached;
  installFakeCache({ putImpl: async (req, resp) => { cached = new Uint8Array(await resp.arrayBuffer()); } });
  const ctx = fakeCtx();
  const resp = await cacheStore(ctx, KEY, new Response(stream));
  const got = new Uint8Array(await resp.arrayBuffer());
  await Promise.all(ctx.pending);
  assert.deepEqual(got, bytes);
  assert.deepEqual(cached, bytes);
});

test("cachePut 不看状态码：/thumb/ 的 302 重定向也要能缓存", async () => {
  const ctx = fakeCtx();
  const redirect = new Response(null, { status: 302, headers: { location: "https://previews.example/x.webp" } });
  await cachePut(ctx, KEY, redirect);
  await Promise.all(ctx.pending);
  const hit = await caches.default.match(new Request(KEY));
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get("location"), "https://previews.example/x.webp");
  assert.equal(redirect.status, 302, "调用方手里的 response 仍可照常返回");
});
