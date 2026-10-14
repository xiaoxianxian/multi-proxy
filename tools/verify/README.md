# multi-proxy 真机验证脚本（给帮忙测试的朋友）

感谢帮忙！这个脚本用来验证 multi-proxy 在**非 macOS** 的真机（Linux / Windows）上
能不能顺利「安装 → 装依赖 → 启动服务 → 健康检查」跑通。

**不需要你有任何 API Key**，也不会产生费用。跑完会生成一份报告文件，
把那个文件发回给我就行。

---

## 它会做什么 / 不会做什么

会做的（都在你自己用户权限内，不需要管理员/root）：

1. 把仓库克隆到 `~/multi-proxy-verify`（Windows: `%USERPROFILE%\multi-proxy-verify`）。
2. 在各子目录里 `npm install` 装依赖。
3. 启动本地服务，监听 **127.0.0.1**（本机回环，不对局域网开放）的 18790~18799 端口。
4. Linux 上会临时创建一个 systemd 用户级自启服务来验证自启路径，**测完会自动移除**。
   Windows 上同理创建一个登录自启计划任务，**测完自动移除**。
5. 逐个端口做 `/health` 健康检查，把结果写进报告。
6. 结束后**自动停止服务并撤销自启**（除非设了 `MP_KEEP=1`）。

不会做的：不会动你系统全局配置，不会改 PATH，不会传任何数据到别处，
不会访问上游大模型（除非你主动填 `DEEPSEEK_API_KEY`）。

---

## 一键运行（复制粘贴即可）

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/xiaoxianxian/multi-proxy/main/tools/verify/verify.sh | bash
```

### Windows（PowerShell，普通权限即可）

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
irm https://raw.githubusercontent.com/xiaoxianxian/multi-proxy/main/tools/verify/verify.ps1 -OutFile $env:TEMP\mpv.ps1
& "$env:TEMP\mpv.ps1"
```

---

## 跑完请把报告发我

- Linux / macOS：`~/multi-proxy-verify-report.txt`
- Windows：`%USERPROFILE%\multi-proxy-verify-report.txt`

直接把这个 `.txt` 发回来即可。如果中途有报错，
把**终端里看到的报错原文**一起发我更好。

---

## 可选：跑全量回归（慢）

默认只做安装 + 启动 + 健康检查，大约 **3~5 分钟**。
如果想顺便跑完整测试套件（约 30~40 分钟），Linux 上这样：

```bash
curl -fsSL https://raw.githubusercontent.com/xiaoxianxian/multi-proxy/main/tools/verify/verify.sh | MP_FULL=1 bash
```

Windows 暂未接全量回归开关（`MP_FULL` 只对 sh 版生效）。

---

## 想保留服务继续用

默认测完就停。如果想留着继续玩：

- Linux：`MP_KEEP=1`（脚本不会停服务、不会撤自启）
- Windows：`$env:MP_KEEP = '1'` 后再运行脚本

手动启停：

- Linux：`cd ~/multi-proxy-verify && bash manage.sh start all` / `stop all`
- Windows：`cd %USERPROFILE%\multi-proxy-verify; .\manage.ps1 start all` / `stop all`

想彻底删掉：`rm -rf ~/multi-proxy-verify`（Windows 删 `%USERPROFILE%\multi-proxy-verify` 目录）。
若之前用了 `MP_KEEP=1`，Linux 先 `bash install.sh --autostop`，
Windows 先 `.\install.ps1 -Uninstall`。

---

## 前置要求

| 依赖 | 要求 |
| --- | --- |
| Node.js | **>= 20**（脚本会检查） |
| Python 3 | hermes 子服务需要 |
| git | 用于克隆仓库 |
| curl | Linux 版需要 |

---

## 已知提示

- 报告里 `结果: 未通过/未启动` 的端口**不一定是问题**——
  部分服务（如 18791 claude / 18798 opencode / 18799 generic）不在默认启动列表内。
  关键看 **18790（codex）** 和 **18792（manager）** 是否为 PASS。
- Windows 版脚本作者本机无 PowerShell 环境、**未经实机自测**；
  如遇脚本本身报错（不是业务报错），请把报错原文发我。
