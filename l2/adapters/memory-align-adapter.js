// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// L2 memory-align adapter（D1「记忆对齐接内核」方案 A 的能力声明 + 注册体）。
// 照 aigc-adapter.js 模板：class + capabilitiesDeclaration()，生命周期全 no-op async。
//
// 非侵入铁律（AGENTS §3）：
//   ① 不写 agent 文件——pull/push 走内核 createMemoryAlign，落盘只走注入 storage，绝不写 ~/.workbuddy/~/.hermes。
//   门控默认关、shadow 默认开——本 adapter 注册后只「声明能力」，真正拉/推由调用方显式驱动，
//     shadow 模式下只算不落盘（PROXY_MEMORY_ALIGN=shadow 默认 / =off 跳过 / =on 落盘）。
//   可回滚：从 l2-bootstrap.DEFAULT_ADAPTERS 摘掉本项即可，不碰热路径 4 文件。
//
// 形态：纯能力声明，l2-bootstrap.wrapAdapterInstance 包成 PluginRuntime 插件（只 register 不 enable/start）。

const { createMemoryAlign } = require('../memory-align.js');

// 默认 reader/target（跨 agent 对齐：hermes 拉 workbuddy 的水位，反之亦然）。
const DEFAULT_READER = 'hermes';
const DEFAULT_TARGET = 'workbuddy';

class MemoryAlignAdapter {
    constructor(opts = {}) {
        this.opts = opts;
        this.reader = opts.reader || DEFAULT_READER;
        this.target = opts.target || DEFAULT_TARGET;
        this.align = null; // 惰性：首次能力驱动时才 createMemoryAlign，避免注册期副作用
    }

    // 能力声明面（供 AgentRegistry / l2-bootstrap 能力查询，listCapabilities 只读 Map）。
    capabilitiesDeclaration() {
        return {
            adapter: 'memory-align',
            version: '1.0.0',
            transport: ['memory-align'],
            capabilities: ['memory-align'],
            supportsTaskQueue: false,
            supportsCancel: false,
            healthEndpoint: '__MEMORY_ALIGN__HEALTH__',
            mode: 'shadow', // 默认 shadow：只算不落盘
         reader: this.reader,
            target: this.target,
        };
    }

     // 生命周期全 no-op async（wrapAdapterInstance 要求 start/stop，本能力零副作用）。
    async init() {}
    async start() {}
    async stop() {}

     // 取内核实例（惰性 + memo）。
    getAlign(overrides = {}) {
        if (!this.align) {
            const opts = Object.assign(
                 { reader: this.reader, target: this.target, storage: this.opts.storage, logger: this.opts.logger, mode: this.opts.mode, now: this.opts.now },
                overrides,
             );
            this.align = createMemoryAlign(opts);
         }
        return this.align;
    }

     // 能力驱动入口：pull target 侧水位增量（shadow 只算不落盘）。
    async pull(targetRaw, targetMtime) {
        return this.getAlign({ target: this.target, raw: targetRaw }).pull(targetRaw, targetMtime);
     }

     // 能力驱动入口：push reader 侧 pending。
    async push(entries) {
        return this.getAlign({ reader: this.reader }).push(entries);
     }

     // 现状：双向水位（供 dashboard）。
    status() {
        return this.getAlign().status();
     }
}

module.exports = {
    MemoryAlignAdapter,
    DEFAULT_READER,
    DEFAULT_TARGET,
};
