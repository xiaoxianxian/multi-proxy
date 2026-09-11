'use strict';

// Plugin Runtime 真跑验证（P0 第三模块）。
// 全程零副作用：插件 dir 写 os.tmpdir()，绝不写 home / agent 文件。
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { PluginRuntime } = require('./plugin-runtime.js');

let n = 0;
const ok = (m, a) => { assert(a, m); n += 1; console.log(`PASS ${m}`); };

// ---- 内存插件：测试生命周期状态机 ----
function makePlugin(name, caps = []) {
    return {
        name,
        version: '1.0.0',
        capabilities: caps,
        init: (ctx) => { ctx.inited = true; },
        start: (ctx) => { ctx.started = true; },
        stop: (ctx) => { ctx.stopped = true; },
     };
}

// 1. register → enabled → started → stopped 状态机
const rt = new PluginRuntime();
rt.register(makePlugin('alpha', [{ name: 'code', desc: 'writes code' }]));
ok('register → state registered', rt.getState('alpha') === 'registered');

(async () => {
    await rt.enable('alpha', { storage: {} });
    ok('enable → state enabled', rt.getState('alpha') === 'enabled');
    await rt.start('alpha');
    ok('start → state started', rt.getState('alpha') === 'started');
    await rt.stop('alpha');
    ok('stop → state stopped', rt.getState('alpha') === 'stopped');
    ok('after stop count still 1', rt.count() === 1);

    // 2. 重复 register 拒绝
    let threw = false;
    try { rt.register(makePlugin('alpha')); } catch { threw = true; }
    ok('duplicate register rejected', threw);

    // 3. 无效插件（缺 start 钩子）拒绝
    threw = false;
    try { rt.register({ name: 'bad', version: '1', init: () => {}, stop: () => {} }); } catch { threw = true; }
    ok('plugin missing start hook rejected', threw);

    // 4. 能力汇总
    rt.register(makePlugin('beta', [{ name: 'vision' }, { name: 'code' }]));
    await rt.enable('beta');
    await rt.start('beta');
    const caps = rt.listCapabilities();
    ok('capabilities aggregated (alpha code + beta code/vision = 3)', caps.length === 3);
    ok('capability has plugin attr', caps.every((c) => typeof c.plugin === 'string'));

    // 5. 热插拔：从 tmp dir 加载插件（require 前清缓存）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-'));
    const pluginDir = path.join(tmp, 'plugins');
    fs.mkdirSync(path.join(pluginDir, 'gamma'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'gamma', 'index.js'),
        "module.exports = { name:'gamma', version:'1.0.0', init:()=>{}, start:()=>{}, stop:()=>{}, capabilities:[] };");
    const loaded = rt.loadFromDir(pluginDir);
    ok('loadFromDir loaded gamma', loaded.includes('gamma'));
    ok('count == 3 after load (alpha+beta+gamma)', rt.count() === 3);

    // 6. unload（stop + 从 registry 移除 + 清缓存）
    await rt.unload('gamma');
    ok('count == 2 after unload gamma', rt.count() === 2);
    ok('unload removed gamma key', !rt.plugins.has('gamma'));

    // 7. 负例：操作不存在的插件
    threw = false;
    try { await rt.start('ghost'); } catch { threw = true; }
    ok('start not-found throws', threw);

    fs.rmSync(tmp, { recursive: true, force: true });

    console.log(`\nDEMO: ALL PASS (${n} checks)`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
