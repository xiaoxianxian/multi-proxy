# manage.ps1 - Multi-Proxy Manager Windows 管理脚本（等价 manage.sh）
# 用法: .\manage.ps1 [start|stop|restart|status|logs] [codex|hermes|cursor|dsh|manager|all]
[CmdletBinding()]
param(
  [string]$Action = 'status',
  [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$LogDir = Join-Path $Root 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

$Ports = @{ codex=18790; hermes=18793; cursor=18794; dsh=18797; manager=18792 }
$Dirs  = @{ codex='codex-proxy'; hermes='hermes-proxy'; cursor='cursor-proxy'; dsh='dsh-proxy'; manager='multi-proxy-manager' }
# Windows 上 Python 可能是 python3 或 python（python.org 安装默认只有 python）
$Py = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } elseif (Get-Command python -ErrorAction SilentlyContinue) { 'python' } else { 'python3' }

function PortInUse($port) {
  try { return [bool](Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue) }
  catch { return $false }
}
function PidOnPort($port) {
  try { (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1 }
  catch { return $null }
}
function StartProxy($name) {
  $port = $Ports[$name]; $dir = Join-Path $Root $Dirs[$name]
  if (-not (Test-Path $dir)) { Write-Warning "$name 目录不存在: $dir"; return }
  if (PortInUse $port) { Write-Host "[!] $name 已在运行 (端口 $port)"; return }
  $log = Join-Path $LogDir "$name-proxy.log"
  if ($name -eq 'hermes') {
    if (-not (Test-Path (Join-Path $dir 'proxy.py'))) { Write-Warning "hermes proxy.py 缺失"; return }
    Start-Process $Py -ArgumentList 'proxy.py' -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  } elseif ($name -eq 'cursor') {
    if (-not (Test-Path (Join-Path $dir 'dist'))) {
      Write-Host "[->] Cursor Proxy 未编译，正在编译..."
      Start-Process -NoNewWindow npm -ArgumentList 'run','build' -WorkingDirectory $dir -Wait
    }
    if (-not (Test-Path (Join-Path $dir 'dist/server/start.js'))) { Write-Warning "Cursor Proxy 未编译"; return }
    Start-Process node -ArgumentList 'dist/server/start.js' -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  } else {
    if (-not (Test-Path (Join-Path $dir 'proxy.js'))) { Write-Warning "$name proxy.js 缺失"; return }
    Start-Process node -ArgumentList 'proxy.js' -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  }
  Start-Sleep -Seconds 2
  if (PortInUse $port) { Write-Host "[OK] $name 启动成功 (端口 $port)" } else { Write-Host "[FAIL] $name 启动失败，看日志: $log" }
}
function StopProxy($name) {
  $port = $Ports[$name]
  if (-not (PortInUse $port)) { Write-Host "[!] $name 未运行"; return }
  $pid = PidOnPort $port
  if ($pid) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
  if (PortInUse $port) { Write-Host "[!] $name 未能停止" } else { Write-Host "[OK] $name 已停止" }
}
function ShowStatus() {
  Write-Host "=========================================="
  Write-Host "  Multi-Proxy Manager 状态"
  Write-Host "=========================================="
  foreach ($name in $Ports.Keys) {
    $port = $Ports[$name]
    if (PortInUse $port) { Write-Host "[OK] $name - 运行中 (端口 $port)" }
    else { Write-Host "[X] $name - 未运行" }
  }
  Write-Host ""
}
function ShowLogs($target) {
  $files = if ($target -eq 'all') { $Ports.Keys } else { @($target) }
  foreach ($n in $files) {
    $log = Join-Path $LogDir "$n-proxy.log"
    Write-Host "=== $n 日志 ==="
    if (Test-Path $log) { Get-Content $log -Tail 50 } else { Write-Host "日志文件不存在" }
    Write-Host ""
  }
}
function RunTarget($verb, $target) {
  $names = if ($target -eq 'all') { $Ports.Keys } else { @($target) }
  foreach ($n in $names) {
    switch ($verb) {
      'start'   { StartProxy $n }
      'stop'    { StopProxy $n }
      'restart' { StopProxy $n; Start-Sleep 1; StartProxy $n }
    }
  }
}

switch ($Action) {
  'start'   { RunTarget 'start' $Target; ShowStatus }
  'stop'    { RunTarget 'stop' $Target; ShowStatus }
  'restart' { RunTarget 'restart' $Target; ShowStatus }
  'status'  { ShowStatus }
  'logs'    { ShowLogs $Target }
  default   { Write-Host "用法: .\manage.ps1 [start|stop|restart|status|logs] [codex|hermes|cursor|dsh|manager|all]" }
}
