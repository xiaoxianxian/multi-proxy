// multi-proxy — Copyright © 2026 xiaoxianxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// P7 第一层：本地预算闸门的 HTTP 面 —— /api/budget
//
// 只做两件事，都**只读**：
//   GET  /api/budget          → 当前周期判级快照（花多少/上限/剩额/按模型/按 agent/未定价笔数）
//   POST /api/budget/collect  → 判级 + 越限 scope 走既有 alert 内核发告警（cost-budget-exceeded 规则）
//
// 边界（与方案文档 §六-6 对齐）：
//   · 单租户本地能力：判「我这台机器这个周期花了多少」，不碰账号/余额/代持。
//   · **没配预算 = 此路由返回 enabled:false**，不拦不报（零行为变更）。
//   · 只读：不写账本、不写 providers.json、不改任何配置；账本从
//     cost-track.readLedgerEntries() 只读取（不应用进内存态，见那个函数的注释）。
//
// 配置文件：~/.multi-proxy-manager/budget.json（位置可用 PROXY_BUDGET_FILE 覆盖，测试用它）
//   {
//     "period": "monthly",                 // daily | monthly
//     "hardCap": 100,                      // CNY；0/缺省 = 关
//     "warnRatio": 0.8,
//     "timezone": "Asia/Shanghai",         // 可选；缺省本机时区
//     "perModel": { "deepseek-v4-flash": 30 },
//     "perAgent": { "dsh": 50 }
//   }

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const router = express.Router();

const budgetGuard = require('../lib/budget-guard');
const costTrack = require('../lib/cost-track');
const alertSvc = require('../../l2/alert.js');

const BUDGET_FILE_DEFAULT = path.join(os.homedir(), '.multi-proxy-manager', 'budget.json');

// 调用时解析（不是模块加载时）：测试用 PROXY_BUDGET_FILE 指到 tmp，
// 与 cost-track.ledgerFile() 的 env 优先级同模式。
function budgetFilePath() {
  const env = process.env.PROXY_BUDGET_FILE;
  return env && env.trim() ? env.trim() : BUDGET_FILE_DEFAULT;
}

// 读配置。文件不存在 = 没配预算（正常状态，不是错误）；畸形 = 报出来并按没配处理
// （与 P6 routing-policy / P3 pricing-schedule 同一条 fail-safe 纪律）。
function loadBudgetConfig() {
  const file = budgetFilePath();
  let raw = null;
  try {
    if (fs.existsSync(file)) {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    return { ok: false, error: `budget.json 读取/解析失败，按未配置处理: ${e.message}` };
  }
  const parsed = budgetGuard.parseBudgetConfig(raw);
  if (!parsed.ok) return { ok: false, error: `budget.json 畸形，按未配置处理: ${parsed.error}` };
  if (!parsed.config || !(parsed.config.hardCap > 0)) {
    return { ok: true, config: null, reason: 'no-budget-config' };
  }
  return { ok: true, config: parsed.config };
}

// 判定一次（只读账本 + 纯函数判级）
function evaluateNow() {
  const loaded = loadBudgetConfig();
  if (!loaded.ok || !loaded.config) {
    return { enabled: false, reason: loaded.ok ? loaded.reason : loaded.error, file: budgetFilePath() };
  }
  const entries = costTrack.readLedgerEntries();
  const result = budgetGuard.evaluateBudget(entries, loaded.config);
  return { ...result, file: budgetFilePath() };
}

// GET /api/budget — 当前周期判级快照
router.get('/', (_req, res) => {
  try {
    res.json({ ok: true, ...evaluateNow() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/budget/collect — 判级 + 越限发告警
// 复用既有 alert 内核的 cost-budget-exceeded 规则（signal 形状 {source:'cost', providerId, cost, budget}），
// 不新增规则、不改 alert.js；cooldown 去重也一并继承（不会每秒刷屏）。
router.post('/collect', (_req, res) => {
  try {
    const snap = evaluateNow();
    if (!snap.enabled) {
      return res.json({ ok: true, enabled: false, reason: snap.reason, alerts: [] });
    }
    const alerts = [];
    for (const ex of snap.exceeded) {
      const sig = { source: 'cost', providerId: `budget:${ex.scope}`, cost: ex.spent, budget: ex.cap };
      for (const a of alertSvc.emit(sig, { persist: true })) alerts.push(a);
    }
    res.json({
      ok: true,
      enabled: true,
      period: snap.period,
      level: snap.level,
      spent: snap.spent,
      cap: snap.cap,
      remaining: snap.remaining,
      unpricedCount: snap.unpricedCount,
      fired: alerts.filter(a => !a.deduped).length,
      alerts,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.BUDGET_FILE_DEFAULT = BUDGET_FILE_DEFAULT;
module.exports.budgetFilePath = budgetFilePath;
module.exports.loadBudgetConfig = loadBudgetConfig;
module.exports.evaluateNow = evaluateNow;
