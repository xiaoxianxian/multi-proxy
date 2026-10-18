const assert = require('assert');
const { byGroup } = require('./agg');

const rows = [
  { group: 'a', cost: 2 },
  { group: 'a', cost: 3 },
  { group: 'b', cost: 1 },
  { cost: 4 },
  { group: 'c' },
];
assert.strictEqual(byGroup(rows).a, 5, '同组累加');
assert.strictEqual(byGroup(rows).unknown, 4, '缺 group 归到 unknown');
assert.strictEqual(byGroup(rows).c, 0, '有 group 无 cost 记 0');
assert.strictEqual(byGroup(rows).undefined, undefined, '不得出现 undefined 键');
console.log('t04 OK');
