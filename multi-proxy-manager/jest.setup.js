// jest 测试隔离：把 logger + error-patterns 的全部文件写入重定向到 tmp，
// 避免 17 个测试文件里打 error 级日志污染真实 ~/.multi-proxy-manager 历史/模式文件。
const os = require('os');
const path = require('path');

const pid = process.pid;
const loggerTmp = path.join(os.tmpdir(), `jest-requests-${pid}.log`);
const errHistTmp = path.join(os.tmpdir(), `jest-error-history-${pid}.jsonl`);
const errPatTmp = path.join(os.tmpdir(), `jest-error-patterns-${pid}.json`);

const logger = require('./lib/logger');
const ep = require('./lib/error-patterns');

logger.setLogFile(loggerTmp);
ep.setHistoryFile(errHistTmp);
ep.setPatternFile(errPatTmp);