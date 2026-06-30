// libheif-js 的 WASM 胶水代码是按 Node.js 环境生成的，在模块求值阶段会引用 __dirname/__filename/process。
// Wrangler 已经把 .wasm 以预编译 Module 的形式注入（不走运行时路径解析），所以这些引用实际上
// 不会被执行到，但只要存在引用就必须有值，否则 Workers 运行时会抛 ReferenceError。
if (typeof globalThis.__dirname === 'undefined') globalThis.__dirname = '/';
if (typeof globalThis.__filename === 'undefined') globalThis.__filename = '/';
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: {}, versions: {}, platform: 'linux' };
}
