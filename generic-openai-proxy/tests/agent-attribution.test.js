// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * agent 归因测试（2026-10-16）—— 兜底值从代理名改成 <unknown> 的行为锁。
 *
 * 为什么值得单独立测：generic-openai-proxy 是「一个适配器覆盖十几种客户端」的网关
 * （cline / aider / openhands / opencode / dsh / codex / cursor / hermes / openai-sdk...）。
 * 此前的兜底是返回代理名 'generic-openai-proxy'，等于把「不知道是哪个客户端在花钱」
 * 记成「网关自己的流量」——归因错了比归因缺失更难看：
 *   · 一个不存在的 agent 长期占据账单首位，读者以为网关自己在烧钱；
 *   · 真正该被点名的接入方（补一个 x-agent 头就能被统计）永远发现不了自己没被算进去。
 * 这正是 multi-proxy 自己的 unknown 态对账纪律：不知道就说不知道，不拿猜测填。
 *
 * 覆盖：显式头优先 / UA 特征 / 兜底 unknown / 可配置 UA 映射 / 坏配置不崩 /
 *       takeover 回落（老部署行为不变）/ openai SDK 不再误判成 codex。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

// ⚠️ require proxy.js 会跑 loadProxy()（含异步模型目录拉取），给足时钟。
jest.setTimeout(60000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'generic-agent-'));
process.env.HOME = tmp;
delete process.env.PROXY_AUTH_TOKEN;
delete process.env.PROXY_AGENT_UA_MAP;   // 默认无映射，逐例再设

const proxy = require('../proxy.js');

const req = (headers) => ({ headers: headers || {} });

describe('detectAgent：归因要诚实，猜不到就说不知道', () => {
  test('显式 x-agent 头最高优先（接入方主动声明）', () => {
    expect(proxy.detectAgent(req({ 'x-agent': 'my-cli', 'user-agent': 'cline/1.0' }))).toBe('my-cli');
    // 前后空白要削掉，否则 "dsh " 和 "dsh" 会是两个 agent
    expect(proxy.detectAgent(req({ 'x-agent': '  dsh  ' }))).toBe('dsh');
  });

  test('UA 特征命中内置表', () => {
    expect(proxy.detectAgent(req({ 'user-agent': 'Cline/2.3.0' }))).toBe('cline');
    expect(proxy.detectAgent(req({ 'user-agent': 'aider/0.60' }))).toBe('aider');
    expect(proxy.detectAgent(req({ 'user-agent': 'OpenHands/0.9' }))).toBe('openhands');
    expect(proxy.detectAgent(req({ 'user-agent': 'opencode/1.0' }))).toBe('opencode');
    expect(proxy.detectAgent(req({ 'user-agent': 'dsh-desktop/0.1.6' }))).toBe('dsh');
    expect(proxy.detectAgent(req({ 'user-agent': 'codex-cli/1.0' }))).toBe('codex');
    expect(proxy.detectAgent(req({ 'user-agent': 'Cursor/0.4' }))).toBe('cursor');
    expect(proxy.detectAgent(req({ 'user-agent': 'hermes/1.0' }))).toBe('hermes');
  });

  test('🔴 兜底是 <unknown>，不是代理名（本次修复的核心）', () => {
    const got = proxy.detectAgent(req({ 'user-agent': 'some-unknown-client/9.9' }));
    expect(got).toBe(proxy.UNKNOWN_AGENT);
    expect(got).toBe('<unknown>');
    expect(got).not.toBe('generic-openai-proxy');
    // 与 cost-track 的哨兵值同串——账本两边才对得上
    expect(got).toBe('<unknown>');
  });

  test('完全没有 UA / 完全没有头 → 也是 <unknown>，不崩', () => {
    expect(proxy.detectAgent(req({}))).toBe('<unknown>');
    expect(proxy.detectAgent(req({ 'user-agent': '' }))).toBe('<unknown>');
  });

  test('/openai/i 单独成条 → openai-sdk，不再被误判成 codex', () => {
    // 旧行为：/codex|openai/i 合并匹配，openai-node 官方库的 UA 也会被记成 codex，
    // 于是「用 openai SDK 的自建客户端」长期顶着 codex 的名字花自己的钱。
    expect(proxy.detectAgent(req({ 'user-agent': 'openai-node/4.0' }))).toBe('openai-sdk');
    expect(proxy.detectAgent(req({ 'user-agent': 'OpenAI/Python 1.0' }))).toBe('openai-sdk');
    // codex 自己仍命中 codex（顺序在 openai 之前）
    expect(proxy.detectAgent(req({ 'user-agent': 'codex/0.1 openai-node' }))).toBe('codex');
  });

  test('PROXY_AGENT_UA_MAP：登记一次即可，不用改代码', () => {
    // 模块级缓存 _uaMapCache 在首次调用时固化，所以本测试必须用独立 registry
    // 的 jest 模块副本——用 jest.isolateModules 拿到干净的缓存。
    let isolated;
    jest.isolateModules(() => {
      process.env.PROXY_AGENT_UA_MAP = JSON.stringify([
        { match: 'myclient', agent: 'my-client' },
        { match: 'other', agent: 'the-other' }
      ]);
      isolated = require('../proxy.js');
    });
    expect(isolated.detectAgent(req({ 'user-agent': 'MyClient/1.0' }))).toBe('my-client');
    // 内置特征仍可命中（映射只是加一层，不替换）
    expect(isolated.detectAgent(req({ 'user-agent': 'cline/1.0' }))).toBe('cline');
    // 未命中任何一条 → 依旧 unknown，不会因为配了映射就换个方式猜
    expect(isolated.detectAgent(req({ 'user-agent': 'zzz' }))).toBe('<unknown>');
    delete process.env.PROXY_AGENT_UA_MAP;
  });

  test('PROXY_AGENT_UA_MAP 是坏 JSON → 警告一次后按「没配」处理，不崩', () => {
    let isolated;
    jest.isolateModules(() => {
      process.env.PROXY_AGENT_UA_MAP = '{ 这不是 json';
      isolated = require('../proxy.js');
    });
    // 坏配置不能把整个代理带崩：照旧走内置表，兜底 unknown
    expect(isolated.detectAgent(req({ 'user-agent': 'cline/1.0' }))).toBe('cline');
    expect(isolated.detectAgent(req({ 'user-agent': 'zzz' }))).toBe('<unknown>');
    delete process.env.PROXY_AGENT_UA_MAP;
  });

  test('PROXY_AGENT_UA_MAP 条目形状不对 → 过滤掉，不静默生效', () => {
    let isolated;
    jest.isolateModules(() => {
      // 缺 agent 字段的条目必须被丢掉：否则 match 命中后返回 undefined，
      // 账本里会出现一个叫 "undefined" 的 agent。
      process.env.PROXY_AGENT_UA_MAP = JSON.stringify([{ match: 'broken' }, { agent: 'no-match' }]);
      isolated = require('../proxy.js');
    });
    expect(isolated.detectAgent(req({ 'user-agent': 'broken-client' }))).toBe('<unknown>');
    delete process.env.PROXY_AGENT_UA_MAP;
  });
});

describe('pickTakeoverAgent：账本诚实与 direct 兼容两不误', () => {
  const dataDir = path.join(tmp, '.multi-proxy-manager');

  test('检测得出 → 原样用于 takeover 查找', () => {
    expect(proxy.pickTakeoverAgent('cline')).toBe('cline');
  });

  test('检测不出且无 takeover-<unknown>.json → 回落代理名（老部署行为不变）', () => {
    const f = path.join(dataDir, 'takeover-<unknown>.json');
    try { fs.unlinkSync(f); } catch { /* 本来就没有 */ }
    // 老部署里 direct 流量靠 takeover-generic-openai-proxy.json 命中；
    // 改了兜底值不能让这条路由悄悄失效。
    expect(proxy.pickTakeoverAgent('<unknown>')).toBe('generic-openai-proxy');
  });

  test('显式建了 takeover-<unknown>.json → 尊重它，用 <unknown>', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'takeover-<unknown>.json'), JSON.stringify({ upstream: 'https://x' }));
    expect(proxy.pickTakeoverAgent('<unknown>')).toBe('<unknown>');
    try { fs.unlinkSync(path.join(dataDir, 'takeover-<unknown>.json')); } catch { /* 清理失败无所谓 */ }
  });
});
