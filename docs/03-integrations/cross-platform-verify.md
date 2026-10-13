# 跨平台安装验证清单（Linux systemd / Windows PowerShell）

> 本机是 macOS，无法实测 Linux/Windows 安装路径。以下为可复现验证步骤，供在真机执行后回填结果。
> 目标：验证 `install → start → status → autostart → stop → uninstall` 全链路在各平台可用。

## 前置（各平台）
- Node.js ≥ 20、Python3 ≥ 3.8。
- Linux：`sudo apt install nodejs npm python3`（或对应包管理器）；Windows：装 Node.js + Python（确保 `python3` 或 `python` 在 PATH）。

---

## A. Linux（systemd --user）

```bash
cd <clone 目录>
bash install.sh --all          # 装依赖 + 生成各 .env + 编译
# 编辑各代理 .env 填 Key
bash manage.sh start           # 启动
bash manage.sh status          # 18590/92/93/94/97 端口应 LISTEN
bash tools/health-all.sh       # 一键核对运行态

# 开机自启
bash install.sh --autostart
systemctl --user status multi-proxy-manager    # 应 active (exited)
# 无登录也常驻（可选）：
loginctl enable-linger "$USER"

# 卸载自启 + 清理
bash install.sh --autostop
systemctl --user status multi-proxy-manager    # 应 not-found / inactive
bash install.sh --uninstall
```

**预期通过标准**：`manage.sh status` 五个端口全绿；`systemctl --user status` 显示 active；autostop 后 not-found。

---

## B. Windows（PowerShell，原生）

```powershell
cd <clone 目录>
# 首次若被策略拦：
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install.ps1                 # 装依赖 + 生成各 .env/config + 启动 + 计划任务自启
.\manage.ps1 status           # 五个端口应「运行中」
# 面板：http://127.0.0.1:18792

# 自启任务核对
Get-ScheduledTask -TaskName MultiProxyManager
# 移除自启
.\install.ps1 -Uninstall
# 停止
.\manage.ps1 stop
```

**预期通过标准**：`.\manage.ps1 status` 全「运行中」；无 PowerShell 参数集报错（已修 `-NoNewWindow`/`-RedirectStandardOutput` 互斥）；计划任务存在且登录时触发。

---

## C. 已知待验证风险点
1. `manage.ps1` 用 `Start-Process -WindowStyle Hidden -RedirectStandardOutput`——PS 5.1 参数集已对齐，但需真机确认进程真起、日志落到 `logs/*.log`。
2. systemd `Type=oneshot + RemainAfterExit` 依赖 `manage.sh start` 用 `nohup` 脱离——确认 `systemctl --user stop` 能干净拉停。
3. Windows Python 可能是 `python` 非 `python3`（`manage.ps1` 已回退），确认 Hermes 能起。
4. 各代理 `.env` 是否被 `install.ps1` 正确生成（已补该逻辑，待确认）。

## D. 回填
| 平台 | install | start | autostart | stop/uninstall | 结论 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| Linux | ☐ | ☐ | ☐ | ☐ | | |
| Windows | ☐ | ☐ | ☐ | ☐ | | |
