'use strict';

// Plugin Runtime — L2 中台插件运行时内核（P0 第三模块，第 1 个交付物）。
// 职责：插件的动态加载 + 生命周期管理（注册 / 启停 / 热插拔），类 DeepSeek Harness。
//
// 设计原则（与 Registry 内核同构，延续 l2/ 非侵入风格）：
//    - 非侵入④：插件写自己 dir（由调用方注入），绝不写 ~/.codex 等 agent 文件。
//    - 零依赖：内核只用 node 内置（require/fs），可移植。
//    - 可注入：pluginDir 可注入（test 写 os.tmpdir()，绝不默认写 home）。
//    - 生命周期：register → enabled → started → stopped；状态机清晰。
//
// 插件约定：每个插件是 L2_PLUGIN_DIR/<name>/index.js，export
//    { name, version, init(ctx), start(ctx), stop(ctx), capabilities: [] }
//    ctx = { logger, registry?, storage }；生命周期钩子可 async。
const path = require('path');
const fs = require('fs');

const PLUGIN_STATES = ['register', 'registered', 'enabled', 'started', 'stopped'];
const REQUIRED_HOOPS = ['name', 'init', 'start', 'stop'];

// 校验插件 manifest 完整性（必需钩子）
function validatePlugin(plugin) {
    const errs = [];
    if (!plugin || typeof plugin !== 'object') return ['plugin not object'];
    for (const h of REQUIRED_HOOPS) {
        if (typeof plugin[h] !== 'function' && h !== 'name' && h !== 'version') {
            errs.push(`missing/invalid hook: ${h}`);
         }
     }
    if (typeof plugin.name !== 'string' || !plugin.name) {
        errs.push('name must be non-empty string');
      }
    return errs.length ? errs : null;
}

class PluginRuntime {
    constructor({ pluginDir, logger } = {}) {
        this.plugins = new Map(); // name → { plugin, state, ctx }
        this.pluginDir = pluginDir || null;
        this.logger = logger || console;
     }

    // 注册插件（内存）：调用方提供 plugin 对象，状态 → registered。
    register(plugin) {
        const errs = validatePlugin(plugin);
        if (errs) throw new Error(`invalid plugin: ${errs.join('; ')}`);
        if (this.plugins.has(plugin.name)) {
            throw new Error(`plugin already registered: ${plugin.name}`);
         }
        this.plugins.set(plugin.name, {
            plugin,
            state: 'registered',
            ctx: null,
          });
        this.logger.log(`[PluginRuntime] registered: ${plugin.name}`);
        return plugin;
     }

    // 从 dir 动态加载插件（热插拔）：扫描 L2_PLUGIN_DIR 下每个子目录的 index.js。
    loadFromDir(dir) {
        const loaded = [];
        const target = dir || this.pluginDir;
        if (!target) throw new Error('pluginDir not set');
        if (!fs.existsSync(target)) throw new Error(`pluginDir not found: ${target}`);
        const entries = fs.readdirSync(target, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const indexPath = path.join(target, e.name, 'index.js');
            if (!fs.existsSync(indexPath)) continue;
            // 热插拔：require 前清缓存，保证重载拿最新代码
            delete require.cache[require.resolve(indexPath)];
            const plugin = require(indexPath);
            this.register(plugin);
            loaded.push(e.name);
         }
        this.logger.log(`[PluginRuntime] loaded ${loaded.length} from ${target}`);
        return loaded;
     }

    // 生命周期：enable → start。ctx 注入 { logger, registry?, storage }。
    async enable(name, ctx = {}) {
        const entry = this.plugins.get(name);
        if (!entry) throw new Error(`plugin not found: ${name}`);
        if (entry.state === 'registered') entry.state = 'enabled';
        entry.ctx = { logger: this.logger, ...ctx };
        await entry.plugin.init(entry.ctx);
        return entry;
     }

    async start(name) {
        const entry = this.plugins.get(name);
        if (!entry) throw new Error(`plugin not found: ${name}`);
        if (entry.state === 'registered') await this.enable(name);
        if (entry.state !== 'enabled') throw new Error(`plugin ${name} not enabled (state=${entry.state})`);
        await entry.plugin.start(entry.ctx);
        entry.state = 'started';
        this.logger.log(`[PluginRuntime] started: ${name}`);
        return entry;
     }

    async stop(name) {
        const entry = this.plugins.get(name);
        if (!entry) throw new Error(`plugin not found: ${name}`);
        await entry.plugin.stop(entry.ctx);
        entry.state = 'stopped';
        this.logger.log(`[PluginRuntime] stopped: ${name}`);
        return entry;
     }

    // 卸载（热插拔的逆操作）：stop 后从 registry 移除，清 require 缓存。
    async unload(name) {
        const entry = this.plugins.get(name);
        if (!entry) throw new Error(`plugin not found: ${name}`);
        if (entry.state === 'started') await this.stop(name);
        this.plugins.delete(name);
        if (this.pluginDir) {
            const indexPath = path.join(this.pluginDir, name, 'index.js');
            const resolved = require.resolve(indexPath);
            delete require.cache[resolved];
         }
        this.logger.log(`[PluginRuntime] unloaded: ${name}`);
        return true;
     }

    // 能力汇总：编排引擎"按能力路由"查所有已启插件的能力。
    listCapabilities() {
        const caps = [];
        for (const [name, entry] of this.plugins) {
            if (Array.isArray(entry.plugin.capabilities)) {
                for (const c of entry.plugin.capabilities) caps.push({ plugin: name, ...c });
             }
         }
        return caps;
     }

    count() { return this.plugins.size; }
    list() { return [...this.plugins.keys()]; }
    getState(name) {
        const e = this.plugins.get(name);
        return e ? e.state : null;
     }
}

module.exports = { PluginRuntime, validatePlugin, PLUGIN_STATES };
