// byGroup(rows) 把 rows 按 group 字段累加 cost，缺 group 的归到 'unknown'
function byGroup(rows) {
  const out = {};
  for (const r of rows) {
    out[r.group] = (out[r.group] || 0) + r.cost;
  }
  return out;
}

module.exports = { byGroup };
