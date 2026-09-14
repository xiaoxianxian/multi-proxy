import fs from 'fs';
import os from 'os';
import path from 'path';
import type { OverrideLogEntry } from '../../src/server/handlers/chatHandler.js';

/**
 * D6-b · override 决策审计「持久化」回归测试。
 *
 * 背景：getOverrideLog 只读内存环形缓冲（重启即失），原 ROADMAP "观测 1-2 天 sign-off"
 * 设计有缺陷——内存态撑不过重启。本轮加可注入 sink（默认关闭）+ readOverrideAudit 读盘，
 * 让审计跨重启留存。本 suite 独立于 PROXY_ROUTE_OVERRIDE，只测持久化本身。
 *
 * 每条用例先 clearOverrideLog() 把内存基线清零（jest clearMocks 只清 mock 不清模块内数组），
 * 再用唯一临时文件落盘，互不污染、不触生产 data/ 目录。
 *
 * 锁 7 项：(1) 默认不写盘 + 行为不变；(2) 接 sink 后 JSONL 追加落盘 + 读回一致；
 * (3) "进程重启"（内存清空+sink 关）后跨重启可读；(4) 坏行跳读不整批丢；
 * (5) 目录不存在自动建；(6) 落盘异常不冒泡（主链路保护）；(7) clearOverrideLog 只清内存不删盘。
 */

function freshModule(): Promise<typeof import('../../src/server/handlers/chatHandler.js')> {
  return import('../../src/server/handlers/chatHandler.js');
}

function entry(over: Partial<OverrideLogEntry> = {}): OverrideLogEntry {
  return {
    timestamp: over.timestamp ?? '2026-09-14T00:00:00Z',
    requestModel: over.requestModel ?? 'qwen3.8-flash',
    engineTaskType: over.engineTaskType ?? 'coding',
    overrideModel: over.overrideModel ?? 'deepseek-v4-pro',
    provider: over.provider ?? 'deepseek',
    applied: over.applied ?? true,
   };
}

describe('D6-b · override 审计持久化（sink 可注入 / 默认关）', () => {
  let auditFile: string;

  beforeEach(() => {
    auditFile = path.join(
      os.tmpdir(),
      `override-audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`,
     );
   });

  afterEach(async () => {
    const mod = await import('../../src/server/handlers/chatHandler.js');
    mod.setOverrideLogSink(null);
    if (fs.existsSync(auditFile)) fs.rmSync(auditFile, { force: true });
    });

  it('默认（未接 sink）：recordOverrideEntry 不写任何磁盘文件（行为与改造前一致）', async () => {
    const mod = await freshModule();
    mod.clearOverrideLog();
    mod.setOverrideLogSink(null);            // 确保默认关
     expect(mod.getOverrideAuditPath()).toBeNull();
    mod.recordOverrideEntry(entry());
    expect(mod.getOverrideLog().length).toBe(1);          // 内存正常记
    expect(fs.existsSync(auditFile)).toBe(false);          // 但没写盘
    });

  it('接 sink 后：每条 override 决策按 JSONL 追加落盘，readOverrideAudit 读回一致', async () => {
    const mod = await freshModule();
    mod.clearOverrideLog();
    mod.setOverrideLogSink(auditFile);
    expect(mod.getOverrideAuditPath()).toBe(auditFile);

    mod.recordOverrideEntry(entry({ timestamp: 't1', engineTaskType: 'coding' }));
    mod.recordOverrideEntry(entry({
      timestamp: 't2',
      engineTaskType: 'translation',
      overrideModel: 'glm-4.5-air',
      provider: 'zhipu',
      applied: false,
      }));

    expect(mod.getOverrideLog().length).toBe(2);
     const fromDisk = mod.readOverrideAudit();
    expect(fromDisk.length).toBe(2);
    expect(fromDisk[0].timestamp).toBe('t1');
    expect(fromDisk[1].applied).toBe(false);
    expect(fromDisk[1].engineTaskType).toBe('translation');
     // JSONL 逐行可解析
    const raw = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
    expect(raw.length).toBe(2);
    JSON.parse(raw[0]);
    JSON.parse(raw[1]);
    });

  it('"进程重启"语义：sink 重置为 null + 内存清空后，readOverrideAudit 仍跨重启读到盘上内容', async () => {
    const mod = await freshModule();
    mod.clearOverrideLog();
    mod.setOverrideLogSink(auditFile);
    mod.recordOverrideEntry(entry({ timestamp: 'pre', overrideModel: 'o-restart' }));
     // 模拟进程重启：内存环清空 + 关闭 sink（盘上留痕保留）
    mod.clearOverrideLog();
    mod.setOverrideLogSink(null);
    expect(mod.getOverrideLog().length).toBe(0);            // 内存已失
     // 盘上还在：指定 path 仍可读（这就是持久化的价值）
    const fromDisk = mod.readOverrideAudit({ path: auditFile });
    expect(fromDisk.length).toBe(1);
    expect(fromDisk[0].overrideModel).toBe('o-restart');
    });

  it('坏行跳读：审计文件含非法 JSON 行时 readOverrideAudit 跳过坏行、不整批丢', async () => {
    const mod = await freshModule();
    mod.clearOverrideLog();
    mod.setOverrideLogSink(auditFile);
    mod.recordOverrideEntry(entry({ timestamp: 'good', engineTaskType: 'coding' }));
     fs.appendFileSync(auditFile, 'NOT_JSON_GARBAGE_LINE\n');
    mod.recordOverrideEntry(entry({ timestamp: 'good2', engineTaskType: 'general', applied: false }));
    const result = mod.readOverrideAudit();
     expect(result.length).toBe(2);
    expect(result.map((r) => r.timestamp)).toEqual(['good', 'good2']);
    });

  it('落盘目标目录不存在时自动创建（mkdir -p 语义）', async () => {
    const mod = await freshModule();
    mod.clearOverrideLog();
    const nested = path.join(os.tmpdir(), `nested-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, 'sub', 'audit.jsonl');
    expect(fs.existsSync(nested)).toBe(false);
    mod.setOverrideLogSink(nested);
    mod.recordOverrideEntry(entry());
    expect(fs.existsSync(nested)).toBe(true);
    expect(mod.readOverrideAudit().length).toBe(1);
    mod.setOverrideLogSink(null);
    fs.rmSync(path.dirname(path.dirname(nested)), { recursive: true, force: true });
    });

  it('落盘异常绝不冒泡（主链路保护）：sink 指向不可写位置时 recordOverrideEntry 不抛', async () => {
    const mod = await freshModule();
    mod.clearOverrideLog();
     // /proc/ 在 macOS 不存在且不可写 → appendFile 抛错应被吞掉
    mod.setOverrideLogSink('/proc/cannot/write-here/audit.jsonl');
    expect(() => mod.recordOverrideEntry(entry())).not.toThrow();
     expect(mod.getOverrideLog().length).toBe(1);    // 内存照常记
    mod.setOverrideLogSink(null);
    });

  it('clearOverrideLog 只清内存、不删盘上审计文件（审计 append-only，与 D2 不变式同原则）', async () => {
    const mod = await freshModule();
    mod.clearOverrideLog();
    mod.setOverrideLogSink(auditFile);
    mod.recordOverrideEntry(entry());
    mod.clearOverrideLog();
    expect(mod.getOverrideLog().length).toBe(0);             // 内存清了
    expect(fs.existsSync(auditFile)).toBe(true);              // 盘上还在
    expect(mod.readOverrideAudit().length).toBe(1);
    });
});
