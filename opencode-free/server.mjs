// opencode-free — 本地 OpenAI 兼容代理：把上游 opencode Zen free 模型请求形态复刻。
// 上游固定用 opencode 形态（core tools + x-opencode-* 头 + /inference/v1 + Bearer public + 强制流式），
// 下游把响应原样转发（流式则透传 SSE，非流式则收集成单条 ChatCompletion）。
// 形态依据：magpie-community/plugins zen-free provider（已证明 200+PONG）。
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { ProxyAgent, fetch } from "undici";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnv(f) { try { for (const l of fs.readFileSync(f, "utf8").split("\n")) { const i = l.indexOf("="); if (i < 0) continue; const k = l.slice(0, i).trim(), v = l.slice(i + 1).trim(); if (k && !(k in process.env)) process.env[k] = v; } } catch (_) {} }
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(here, ".env")); loadDotEnv(".env");
const PORT = Number(process.env.OPENCODE_FREE_PORT || 18800);
const UPSTREAM = process.env.OPENCODE_UPSTREAM || "https://opencode.ai/inference/v1";
const CHAT = process.env.OPENCODE_UA || "opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";
const PROXY = process.env.OPENCODE_PROXY || "http://127.0.0.1:7897";
const agent = PROXY ? new ProxyAgent(PROXY) : undefined;
// 默认 public（仅免费目录 + 形态转发）；填 OPENCODE_API_KEY 后用真实 opencode 账号 key，
// 付费模型可调通、免费模型在登录态下一般也通。key 只进 .env，不落 plist。
const API_KEY = process.env.OPENCODE_API_KEY || process.env.OPENCODE_PUBLIC_KEY || "public";
// KEY_MODE 只在「真实账号 key」（非 public、非空）时算 account；.env 默认占位 "public" 不算已设 key。
const KEY_MODE = (process.env.OPENCODE_API_KEY && process.env.OPENCODE_API_KEY !== "public" && process.env.OPENCODE_API_KEY.trim() !== "") ? "account" : "public";
const IDLE_MS = Number(process.env.OPENCODE_STREAM_IDLE_MS || 60000);
const RETRY_400 = process.env.OPENCODE_RETRY_400 !== "0"; // 默认开，偶发 400 重试一次

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastStamp = 0, counter = 0;
function opencodeID(prefix, descending, now) {
  now = now || Date.now();
  if (now !== lastStamp) { lastStamp = now; counter = 0; }
  counter++;
  const current = (BigInt(now) & 0xfffffffffffn) * 0x1000n + BigInt(counter);
  const value = (descending ? ~current : current) & 0xffffffffffffn;
  let tail = ""; for (const b of randomBytes(14)) tail += ALPHABET[b % 62];
  return prefix + "_" + value.toString(16).padStart(12, "0") + tail;
}
const CORE_TOOLS = [
  ["bash","command"],["edit","filePath"],["glob","pattern"],["grep","pattern"],["read","filePath"],
].map(([n, p]) => ({ type:"function", function:{ name:n, description:"Not available. Never call this tool.", parameters:{ type:"object", properties:{ [p]:"string" }, additionalProperties:false } } }));

const srv = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url.indexOf("/healthz") === 0) {
      res.writeHead(200, { "content-type":"application/json" });
      res.end(JSON.stringify({ ok:true, name:"opencode-free", port:PORT, upstream:UPSTREAM, proxy:PROXY || null, key_mode:KEY_MODE, key_set:API_KEY!=="public" }));
      return;
    }
    if (req.method === "GET" && /\/v1\/models(\/|$|\?)/.test(req.url)) {
      const r = await fetch(UPSTREAM + "/models", { dispatcher: agent, headers: { authorization:"Bearer "+API_KEY, "x-opencode-client":"cli" } });
      const txt = await r.text();
      // 复刻 workbuddy 式目录：转发全部模型，但给每条加 is_free 标记，便于下游(hermes/dsh)自己识别免费。
      try {
        const j = JSON.parse(txt);
        let free = 0, paid = 0;
        if (j.data && Array.isArray(j.data)) {
          for (const m of j.data) {
            const id = String(m.id || m.name || "");
            const isFree = /(^|[\s._-])free($|[\s._-])/i.test(id); // opencode 约定：id 含 "free" 段即免费
            m.is_free = isFree;
            isFree ? free++ : paid++;
           }
          j.object = "list";
          j._meta = { source:"opencode-free", total:j.data.length, free, paid,
            free_rule:"模型 id 含 'free' 段（opencode 命名约定）即免费、走 Bearer public",
            key_mode:KEY_MODE, key_set:API_KEY!=="public" };
        }
        res.writeHead(r.status, { "content-type":"application/json" });
        res.end(JSON.stringify(j));
      } catch (_) {
        res.writeHead(r.status, { "content-type":"application/json" });
        res.end(txt);
      }
      return;
     }
    if (req.method === "POST" && /\/chat\/completions(\/|$|\?)/.test(req.url)) {
      let body = ""; for await (const c of req) body += c;
      const incoming = JSON.parse(body || "{}");
      const wantStream = incoming.stream === true;
      const messages = incoming.messages || [{ role:"user", content:"Reply with exactly the word PONG." }];
      // 去掉 provider 前缀（如 opencodezenfree/beam-free → beam-free）
      const model = String(incoming.model || "beam-free").split("/").pop();
      const ocReq = { model, messages, tools: CORE_TOOLS, stream: true, stream_options: { include_usage: true } };
      // 形态头（不含会话）+ 每次尝试现造 opencode session（ses/msg id，opencode 约定式）。
      const baseHeaders = {
        "content-type":"application/json", "accept":"text/event-stream", "user-agent":CHAT,
        "x-opencode-project":"global", "x-opencode-client":"cli", "authorization":"Bearer "+API_KEY,
      };
      const mkSes = () => { const s = opencodeID("ses",true); return { "x-opencode-session":s, "x-opencode-request":opencodeID("msg",false), "x-opencode-session-id":s }; };
      const ocBody = JSON.stringify(ocReq);
       // 偶发 400 重试：opencode 网关偶发 400 → 换新 session 重试一次；401/403（认证/会话门）不重试。
      // 默认开，OPENCODE_RETRY_400=0 关。
      let up; let lastStatus = 0;
      const maxAttempts = RETRY_400 ? 2 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        up = await fetch(UPSTREAM + "/chat/completions", { method:"POST", headers:{...baseHeaders, ...mkSes()}, body:ocBody, dispatcher: agent });
        lastStatus = up.status;
        if (process.env.DBG) console.error("[DBG] upstream", up.status, "attempt", attempt, "of", maxAttempts, "via", PROXY || "direct");
        if (up.status === 400 && attempt < maxAttempts) {
          if (up.body && up.body.cancel) { try { up.body.cancel(); } catch(_){} }
          await new Promise(r => setTimeout(r, 1500 * attempt)); // 1.5s / 3s 退避
          continue;
         }
        break;
       }
      if (!up.ok || !up.body) {
        const txt = await up.text();
        res.writeHead(lastStatus, { "content-type":"application/json" });
        res.end(txt);
        return;
      }
      if (wantStream) {
        res.writeHead(200, { "content-type":"text/event-stream", "cache-control":"no-cache", "connection":"close" });
        let idle = null;
        const bump = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { if (up.body && up.body.cancel) up.body.cancel(); }, IDLE_MS); };
        bump();
        try { for await (const chunk of up.body) { bump(); res.write(chunk); } } catch (_) {}
        if (idle) clearTimeout(idle);
        res.end();
        return;
      }
      // 非流式：收集 SSE 成单条 ChatCompletion
      let acc = ""; const dec = new TextDecoder();
      let idle2 = null;
      const bump2 = () => { if (idle2) clearTimeout(idle2); idle2 = setTimeout(() => { if (up.body && up.body.cancel) up.body.cancel(); }, IDLE_MS); };
      bump2();
      try { for await (const chunk of up.body) { bump2(); acc += dec.decode(chunk, { stream:true }); } } catch (_) {}
      if (idle2) clearTimeout(idle2);
      let content = "";
      for (const line of acc.split("\n")) {
        if (line.indexOf("data:") !== 0) continue;
        const p = line.slice(5).trim();
        if (!p || p === "[DONE]") continue;
        try { const j = JSON.parse(p); const d = j.choices && j.choices[0]; if (d && d.delta && d.delta.content) content += d.delta.content; if (d && d.message && d.message.content) content += d.message.content; } catch(e) {}
      }
      const out = { id:"chatcmpl-zenfree", object:"chat.completion", model, choices: [{ index:0, message:{ role:"assistant", content }, finish_reason:"stop" }] };
      res.writeHead(200, { "content-type":"application/json" });
      res.end(JSON.stringify(out));
      return;
    }
    res.writeHead(404, { "content-type":"application/json" });
    res.end(JSON.stringify({ error: { message: "opencode-free: no route " + req.url } }));
  } catch (e) {
    res.writeHead(500, { "content-type":"application/json" });
    res.end(JSON.stringify({ error: { message: "opencode-free: " + e.message } }));
    console.error("ERR", e);
  }
});
srv.listen(PORT, "127.0.0.1", () => console.log("opencode-free shim listening on 127.0.0.1:" + PORT + " (upstream " + UPSTREAM + (PROXY ? " via " + PROXY : " direct") + ")"));
