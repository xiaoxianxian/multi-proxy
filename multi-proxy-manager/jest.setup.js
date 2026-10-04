// jest 测试隔离：把 logger + error-patterns + 成本账本的全部文件写入重定向到 tmp，
// 避免 17 个测试文件里打 error 级日志污染真实 ~/.multi-proxy-manager 历史/模式/账本文件。
const os = require('os');
const path = require('path');

const pid = process.pid;
const loggerTmp = path.join(os.tmpdir(), `jest-requests-${pid}.log`);
const errHistTmp = path.join(os.tmpdir(), `jest-error-history-${pid}.jsonl`);
const errPatTmp = path.join(os.tmpdir(), `jest-error-patterns-${pid}.json`);
const phTmp = path.join(os.tmpdir(), `jest-provider-health-${pid}.json`);
// 成本账本（cost-track 的 cost-ledger.jsonl）：走 env 而不是 setLedgerFile，
// 因为 ledgerFile() 每次调用都读 PROXY_COST_LEDGER。不重定向的话，任何在门控开时
// 落账的用例都会往真实账本里塞假数据（2026-10-03 实测一次全量套件写了 14 行）。
const ledgerTmp = path.join(os.tmpdir(), `jest-cost-ledger-${pid}.jsonl`);
process.env.PROXY_COST_LEDGER = ledgerTmp;

const logger = require('./lib/logger');
const ep = require('./lib/error-patterns');

logger.setLogFile(loggerTmp);
ep.setHistoryFile(errHistTmp);
ep.setPatternFile(errPatTmp);
const ph = require('./lib/provider-health');
ph.setHealthFile(phTmp);
ph.resetProviderHealth();
