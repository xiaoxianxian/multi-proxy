// Per-test process.env 快照/恢复 —— 根治跨文件 env 泄漏导致的 flaky。
//
// 背景：多个 route test 在 module-load 级设 process.env.PROXY_* / JWT_SECRET
//（如 logs.test.js L7、api.test.js L1、各门控 test），且不恢复。jest 同 worker
//进程串行跑多个 test 文件、共享 process.env → 上一个文件设的 env 泄漏污染下一个
//文件的门控/鉴权断言（403/undefined 翻转）→ ~3% flaky（ victims 轮转
//sessions-lazy-store / api / logs）。
//
// 修复：在 setupFilesAfterEnv（框架上下文，afterEach 可用）里，每个 test 后把
//process.env 恢复到本 worker 加载时的原始快照 —— 删掉 test 新增的 key、重置被改的 key。
//这是 jest 文档化的 env 隔离标准做法，只清 afterEach 之后、不影响 test 自身运行。
const envSnap = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in envSnap)) delete process.env[k];
  }
  for (const k of Object.keys(envSnap)) {
    if (process.env[k] !== envSnap[k]) process.env[k] = envSnap[k];
  }
});
