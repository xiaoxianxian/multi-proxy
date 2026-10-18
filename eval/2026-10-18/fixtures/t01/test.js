const assert = require('assert');
const { sumRange } = require('./lib');

assert.strictEqual(sumRange([1, 2, 3, 4], 1, 3), 9, '闭区间求和应为 2+3+4=9');
assert.strictEqual(sumRange([5, 5, 5], 0, 2), 15, '全区间求和');
assert.strictEqual(sumRange([1, 2, 3], 2, 2), 3, '单元素区间');
console.log('t01 OK');
