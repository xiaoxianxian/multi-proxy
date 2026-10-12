// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
//
// 收费确认闸门（MPT 契约落地 · 2026-10-12）端到端测试
// 起一个可出 200 的假上游，验证 savings-gateway 的 X-Charge-Confirm 协议层强制确认：
//   ① 默认关（PROXY_SAVINGS_CHARGE_CONFIRM 未设）→ 付费路由真执行，200 放行（零行为变更）
//   ② 开 + 付费路由未带确认头 → 402 charge_confirmation_required（打不到上游、不产生省账）
//   ③ 开 + 付费路由带 X-Charge-Confirm: true → 放行，真打上游 200
//   ④ 开 + shadow 模式（不真花钱）→ 不拦（与 MPT「模拟=免费」一致）
// 全程不依赖真实 provider key，确定性、可离线跑。
//
// 用法：node l2/savings-gateway/charge-confirm.e2e.test.js

'use strict';

// 开网关门控（否则 /v1/chat/completions 返回 403 gate-closed），仅本测试进程生效
process.env.PROXY_SAVINGS_GATEWAY = '1';
// 清掉收费确认门控，保证「默认关」路径从干净环境起测
delete process.env.PROXY_SAVINGS_CHARGE_CONFIRM;

const http = require('http');
const assert = require('assert');
const { createServer } = require('./server.js');
const { createSavingsGateway, createForwardExecutor } = require('./gateway.js');
const { createChargeConfirmGate } = require('./charge-confirm.js');

function startFakeUpstream() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK from upstream' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function post(port, body, auth, chargeConfirmHeader) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      Authorization: auth || 'Bearer gw_default-large',
    };
    if (chargeConfirmHeader) headers['X-Charge-Confirm'] = chargeConfirmHeader;
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers,
    }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => resolve({ status: r.statusCode, body: b, json: JSON.parse(b || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  const up = await startFakeUpstream();
  const upPort = up.address().port;
  const upEx = createForwardExecutor(`http://127.0.0.1:${upPort}`);
  const body = { messages: [{ role: 'user', content: 'hi' }], complexity: 'high', usage: { prompt_tokens: 1, completion_tokens: 1 } };
  let pass = 0;
  const check = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✓ ${name}`); };

  // ① 默认关：付费路由（high→qwen/large）真执行，200 放行（零行为变更）
  {
    const gw = createSavingsGateway({ executor: upEx, shadow: false });
    const srv = createServer({ gateway: gw, executor: upEx });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;
    const r = await post(p, body);
    check('默认关：付费路由真执行 → 200（零行为变更）', r.status === 200 && r.body.includes('OK from upstream'));
    srv.close();
  }

  // ② 开 + 未带确认头：付费路由真执行 → 402，且打不到上游、不产生省账
  {
    const gate = createChargeConfirmGate({}); // 默认名单 deepseek/qwen
    const gw = createSavingsGateway({ executor: upEx, shadow: false, chargeConfirm: gate });
    const srv = createServer({ gateway: gw, executor: upEx, chargeConfirm: gate });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;
    const r = await post(p, body, 'Bearer gw_default-large', undefined); // 不带确认头
    check('开 + 未确认：402 拦截', r.status === 402);
    check('错误类型 = charge_confirmation_required', r.json.error.type === 'charge_confirmation_required');
    check('结构化 verdict 随响应带出（reason 明确）', r.json.chargeConfirm && r.json.chargeConfirm.reason === 'charge-confirmation-required');
    check('未打上游（无内容、无模拟体）', !r.body.includes('OK from upstream'));
    srv.close();
  }

  // ③ 开 + 带 X-Charge-Confirm: true：付费路由放行，真打上游 200
  {
    const gate = createChargeConfirmGate({});
    const gw = createSavingsGateway({ executor: upEx, shadow: false, chargeConfirm: gate });
    const srv = createServer({ gateway: gw, executor: upEx, chargeConfirm: gate });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;
    const r = await post(p, body, 'Bearer gw_default-large', 'true');
    check('开 + 已确认：200 放行，真打上游', r.status === 200 && r.body.includes('OK from upstream'));
    srv.close();
  }

  // ④ 开 + shadow 模式（不真花钱）：不拦，模拟直接放行
  {
    const gate = createChargeConfirmGate({});
    const gw = createSavingsGateway({ chargeConfirm: gate, shadow: true });
    const srv = createServer({ gateway: gw, chargeConfirm: gate });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const p = srv.address().port;
    const r = await post(p, body);
    check('shadow（不真花钱）：不拦，模拟放行 200', r.status === 200);
    srv.close();
  }

  up.close();
  console.log(`\n[charge-confirm e2e] PASS ${pass} / ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
