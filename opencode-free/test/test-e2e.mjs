// opencode-free E2E 自检：healthz + /v1/models(is_free) + 一次 chat 调用。
// 用法：node test/test-e2e.mjs   （插件须已在 OPENCODE_FREE_PORT 上跑）
// 不联网断言：插件不可达 / 免费门时如实报告，不假装通过。
const PORT = Number(process.env.OPENCODE_FREE_PORT || 18800);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("  ✓", m)) : (fail++, console.log("  ✗", m)); };

async function main() {
  console.log("opencode-free E2E @ " + BASE);

  // 1. healthz
  try {
    const r = await fetch(BASE + "/healthz");
    const j = await r.json();
    ok(r.status === 200, "healthz 200");
    ok(j && j.ok === true, "healthz.ok=true");
    ok(typeof j.key_mode === "string", "healthz 带 key_mode=" + j.key_mode + " key_set=" + j.key_set);
    console.log("    upstream=" + j.upstream + " proxy=" + (j.proxy || "direct"));
  } catch (e) { fail++; console.log("  ✗ healthz 不可达:", e.message); }

  // 2. /v1/models + is_free + _meta
  try {
    const r = await fetch(BASE + "/v1/models");
    const j = await r.json();
    const data = Array.isArray(j.data) ? j.data : [];
    ok(r.status === 200, "/v1/models 200");
    ok(data.length > 0, "有 " + data.length + " 个模型");
    const withFlag = data.filter(m => typeof m.is_free === "boolean").length;
    ok(withFlag === data.length, "全部 " + withFlag + "/" + data.length + " 条带 is_free");
    const free = data.filter(m => m.is_free);
    ok(free.length > 0, "识别出 " + free.length + " 个免费模型: " + free.slice(0, 5).map(m => m.id).join(", "));
    ok(j._meta && typeof j._meta.total === "number", "_meta.total=" + (j._meta && j._meta.total));
  } catch (e) { fail++; console.log("  ✗ /v1/models:", e.message); }

  // 3. 一次 chat（付费或免费都可能被上游门挡，但插件路由必须不报错 500）
  try {
    const r = await fetch(BASE + "/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "beam-free", messages: [{ role: "user", content: "PONG" }] }),
    });
    const txt = await r.text();
    console.log("    chat 状态 " + r.status + " 首 160 字: " +
      txt.replace(/\s+/g, " ").slice(0, 160));
    ok(r.status !== 500, "chat 路由未 500（即使被上游 FreeTierError/AuthError 挡，也应是 4xx）");
    if (/FreeTierError|AuthError|RegionError/.test(txt))
      console.log("    ⚠️ 上游门生效（FreeTierError/AuthError/RegionError）—— 预期：免费需账号 key / 地区门；填 OPENCODE_API_KEY 后解");
  } catch (e) { fail++; console.log("  ✗ chat 路由:", e.message); }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
main();
