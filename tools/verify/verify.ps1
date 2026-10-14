# multi-proxy 跨平台一键验证脚本（Windows / PowerShell）
#
# 目的：在没有上游 API Key 的前提下，验证「安装 → 依赖 → 启动 → 端口 → 健康检查」
#       这条链路在真机上是否跑得通，并产出一份可直接回传的报告。
#
# 用法（一键，推荐；在 PowerShell 里执行）：
#   Set-ExecutionPolicy Bypass -Scope Process -Force
#   irm https://raw.githubusercontent.com/xiaoxianxian/multi-proxy/main/tools/verify/verify.ps1 -OutFile $env:TEMP\mpv.ps1
#   & "$env:TEMP\mpv.ps1"
#
# 或先克隆再跑：
#   git clone https://github.com/xiaoxianxian/multi-proxy.git
#   cd multi-proxy; .\tools\verify\verify.ps1
#
# 可选：
#   $env:MP_KEEP = '1'   结束后保留服务运行与登录自启（默认测完即停、即清理）
#
# 产出报告：$env:USERPROFILE\multi-proxy-verify-report.txt（把这个文件发回即可）
#
# 注意：本脚本未在 macOS 上实测（作者机器无 pwsh），如遇报错请把报错原文一并发回。

$ErrorActionPreference = 'Continue'

$Report = Join-Path $env:USERPROFILE 'multi-proxy-verify-report.txt'
$Work   = Join-Path $env:USERPROFILE 'multi-proxy-verify'
$Repo   = 'https://github.com/xiaoxianxian/multi-proxy.git'
$Keep   = if ($env:MP_KEEP -eq '1') { $true } else { $false }

# 清空报告
'' | Set-Content -Path $Report -Encoding UTF8

function Say($msg) {
  Write-Host $msg
  Add-Content -Path $Report -Value $msg -Encoding UTF8
}
function Hr {
  Say ''
  Say '==========================================================='
}
function Step($desc, $cmd) {
  Say ''
  Say "### $desc"
  Say "PS> $cmd"
  try {
    $out = Invoke-Expression $cmd 2>&1 | Out-String
    if ($out.Length -gt 3000) { $out = $out.Substring(0, 3000) + ' ...(已截断)' }
    Say $out.Trim()
    Say '结果: 已执行（请看下方可读输出是否含报错）'
  } catch {
    Say "结果: FAIL - $($_.Exception.Message)"
  }
}

Hr
Say 'multi-proxy 真机验证报告 (Windows)'
Say "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say "报告路径: $Report"
Hr

# ---------- 1. 环境信息 ----------
Say ''
Say '## 1. 环境信息'
Step '系统版本'   '[System.Environment]::OSVersion.VersionString'
Step '计算机名'   '$env:COMPUTERNAME'
Step 'PowerShell' '$PSVersionTable.PSVersion.ToString()'
Step 'git 版本'   'git --version'
Step 'node 版本'  'node -v'
Step 'npm 版本'   'npm -v'

try {
  $py = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' }
        elseif (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { $null }
  if ($py) { Step 'python 版本' "& $py --version" } else { Say 'python: 未安装' }
} catch { Say 'python 检测失败' }

# Node >= 20 硬门槛
try {
  $v = (node -v) -replace '^v', ''
  $major = [int]($v.Split('.')[0])
  Say ''
  if ($major -ge 20) { Say "Node 版本检查: PASS (v$major >= 20)" }
  else { Say "Node 版本检查: FAIL（需要 Node.js >= 20，当前 v$v）" }
} catch {
  Say ''
  Say 'Node 版本检查: FAIL（node 未安装或无法执行）'
}

# ---------- 2. 获取代码 ----------
Say ''
Say '## 2. 获取代码'
if ((Test-Path '.\install.sh') -or (Test-Path '.\install.ps1')) {
  $Work = (Get-Location).Path
  Say "检测到当前就在 multi-proxy 目录，直接使用: $Work"
} else {
  Step "克隆仓库到 $Work" "git clone --depth 1 '$Repo' '$Work'"
}

if (-not (Test-Path $Work)) {
  Say ''
  Say '代码获取失败，后续步骤无法继续。请把本文件发回，谢谢！'
  Hr
  exit 1
}
Set-Location $Work
Step '当前 HEAD' 'git log --oneline -1'

# ---------- 3. 安装 ----------
Say ''
Say '## 3. 安装（install.ps1：依赖 + 启动 + 登录自启）'
Step '执行 install.ps1' "powershell -ExecutionPolicy Bypass -NoProfile -File '$Work\install.ps1'"

# ---------- 4. 启动服务 ----------
Say ''
Say '## 4. 启动服务'
Step 'manage.ps1 start all' "powershell -ExecutionPolicy Bypass -NoProfile -File '$Work\manage.ps1' start all"

Say ''
Say '等待服务就绪（最多 90s）...'
Start-Sleep -Seconds 20
$waited = 20
while ($waited -lt 90) {
  $ok = $false
  foreach ($p in @(18790, 18792)) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      if ($r.StatusCode -eq 200) { $ok = $true }
    } catch { }
  }
  if ($ok) { break }
  Start-Sleep -Seconds 10
  $waited += 10
}
Say "已等待 $waited s"

Say ''
Say '## 4b. 服务状态'
Step 'manage.ps1 status' "powershell -ExecutionPolicy Bypass -NoProfile -File '$Work\manage.ps1' status"

# ---------- 5. 端口与健康检查 ----------
Say ''
Say '## 5. 端口与健康检查'
foreach ($p in @(18790, 18791, 18792, 18793, 18794, 18798, 18799)) {
  $code = '000'
  $body = ''
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    $code = [string]([int]$r.StatusCode)
    $body = $r.Content
  } catch {
    $code = '000'
    $body = $_.Exception.Message
  }
  Say ''
  Say "端口 $p -> HTTP $code"
  if ($body.Length -gt 160) { $body = $body.Substring(0, 160) }
  Say "  响应: $body"
  if ($code -eq '200') { Say '  结果: PASS' } else { Say '  结果: 未通过/未启动（若该服务本就不在启动列表内属正常）' }
}

# ---------- 6. 清理 ----------
Say ''
Say '## 6. 清理'
if ($Keep) {
  Say 'MP_KEEP=1，保留服务运行与登录自启，不做清理。'
} else {
  Step '停止全部服务'   "powershell -ExecutionPolicy Bypass -NoProfile -File '$Work\manage.ps1' stop all"
  Step '移除登录自启'   "powershell -ExecutionPolicy Bypass -NoProfile -File '$Work\install.ps1' -Uninstall"
  Say "已停止服务并移除登录自启（仓库代码保留在 $Work，可自行删除）。"
}

Hr
Say '验证结束。'
Say "请把本文件发回：$Report"
Hr
