// sumRange(nums, start, end) 应返回 nums[start..end] 的和（含 end）
function sumRange(nums, start, end) {
  let total = 0;
  for (let i = start; i < end; i += 1) {
    total += nums[i];
  }
  return total;
}

module.exports = { sumRange };
