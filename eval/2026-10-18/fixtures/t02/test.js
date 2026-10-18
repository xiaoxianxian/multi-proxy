const assert = require('assert');
const { parseLine } = require('./parse');

assert.deepStrictEqual(parseLine('a,"b,c",d'), ['a', 'b,c', 'd'], '引号内逗号不分隔');
assert.deepStrictEqual(parseLine('a,b,c'), ['a', 'b', 'c'], '普通行');
console.log('t02 OK');
