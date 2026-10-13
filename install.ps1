# install.ps1 - Multi-Proxy Manager Windows 安装器（等价 install.sh --all + --autostart）
# 用法:
#   .\install.ps1           安装依赖 + 启动 + 配置登录自启
#   .\install.ps1 -Start    仅启动
#   .\install.ps1 -Stop     仅停止
#   .\install.ps1 -Status   查看状态
#   .\install.ps1 -Uninstall 移除开机自启任务
[CmdletBinding()]
param(
  [switch]$Start,
  [switch]$Stop,
  [switch]$Status,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$TaskName = 'MultiProxyManager'

function Need($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

if ($Uninstall) {
  Write-Host "[->] 移除开机自启任务 $TaskName ..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "[OK] 已移除（服务进程需手动停止: .\manage.ps1 stop）"
  exit 0
}
if ($Stop)    { & "$Root\manage.ps1" stop;    exit 0 }
if ($Status)  { & "$Root\manage.ps1" status;  exit 0 }
if ($Start)   { & "$Root\manage.ps1" start;   exit 0 }

# 依赖检查
if (-not (Need node)) { Write-Error "缺少 Node.js，请先安装: https://nodejs.org/"; exit 1 }
if (-not ((Need python3) -or (Need python))) { Write-Error "缺少 Python3，请先安装: https://www.python.org/ （并确保 python3 或 python 在 PATH）"; exit 1 }

# 各代理依赖安装（已存在 node_modules 则跳过）
foreach ($d in @('codex-proxy','hermes-proxy','cursor-proxy','dsh-proxy','multi-proxy-manager')) {
  $dir = Join-Path $Root $d
  if (Test-Path (Join-Path $dir 'package.json')) {
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
      Write-Host "[->] 安装 $d 依赖..."
      Start-Process -NoNewWindow npm -ArgumentList 'install','--production' -WorkingDirectory $dir -Wait
    }
  }
}

# 从 .env.example 生成各代理 .env（开箱：装完即有配置骨架，已存在则不覆盖）
foreach ($d in @('codex-proxy','hermes-proxy','cursor-proxy','dsh-proxy','multi-proxy-manager')) {
  $dir = Join-Path $Root $d
  $env = Join-Path $dir '.env'
  $ex  = Join-Path $dir '.env.example'
  if ((Test-Path $ex) -and (-not (Test-Path $env))) {
    Copy-Item $ex $env
    Write-Host "[->] 已创建 $d/.env，请编辑配置 API Key"
  }
}
# Hermes 用 YAML 配置
$hdir = Join-Path $Root 'hermes-proxy'
$hy = Join-Path $hdir 'config.yaml'; $hex = Join-Path $hdir 'config.yaml.example'
if ((Test-Path $hex) -and (-not (Test-Path $hy))) {
  Copy-Item $hex $hy
  Write-Host "[->] 已创建 hermes-proxy/config.yaml"
}

# 启动
Write-Host "[->] 启动所有服务..."
& "$Root\manage.ps1" start

# 配置登录自启（当前用户，无需管理员权限）
Write-Host "[->] 配置开机自启（登录时）..."
$exe = (Get-Command powershell.exe).Source
$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$Root\manage.ps1`" start"
$action = New-ScheduledTaskAction -Execute $exe -Argument $arg
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Write-Host "[OK] 已配置开机自启任务: $TaskName"
Write-Host "[i] 移除自启: .\install.ps1 -Uninstall"
