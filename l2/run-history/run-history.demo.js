// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// G5 demo：治理事件落本地 JSONL，跨重启可查
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createRunHistory } = require('./run-history.js');

const tmp = path.join(os.tmpdir(), `run-history-demo-${Date.now()}.jsonl`);
const rh = createRunHistory({ enabled: true, logFile: tmp });

rh.append({ type: 'cost-record', level: 'ok', cumulative: 0.096 });
rh.append({ type: 'threshold-alert', ratio: 0.8, cumulative: 0.16 });
rh.append({ type: 'block', cumulative: 0.21, hardCap: 0.2 });

console.log('== 首次写入后查询 ==');
console.log(JSON.stringify(rh.query(), null, 2));
console.log('block 类型事件：', JSON.stringify(rh.query({ type: 'block' }), null, 2));

// 模拟「重启」：用同一文件新建实例读回
const rh2 = createRunHistory({ enabled: true, logFile: tmp });
console.log('\n== 跨实例（重启）读回 ==');
console.log('total rows =', rh2.query().length, '| block =', JSON.stringify(rh2.query({ type: 'block' })));

fs.unlinkSync(tmp);
console.log('\n(demo 临时文件已清理)');
