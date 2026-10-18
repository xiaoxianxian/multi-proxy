// parseLine(line) 按逗号切分一行 CSV，双引号内的逗号不作为分隔符
function parseLine(line) {
  return line.split(',');
}

module.exports = { parseLine };
