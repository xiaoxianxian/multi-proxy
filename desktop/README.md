# Proxy Manager Desktop（应用壳）

给现有 Web 管理台套的 Electron 桌面壳：Dock 有图标、双击即用、拖废纸篓即卸载。

## 架构决策：壳 = 启动器 + 窗口

**业务代码不进 .app**。壳只负责：

1. 确保 manager (18792) 在跑——已在跑则附着，没跑则拉起
2. 开一个 BrowserWindow 加载 `http://127.0.0.1:18792`
3. 退出时只回收**自己拉起的** manager（附着外部启动的不动）

为什么不打包业务代码进 .app：
- cursor-proxy 的 better-sqlite3 ABI 绑定本机 Node v22，捆绑运行时会破坏 ABI 匹配
- 四个服务 node_modules ~840MB，双份没有意义
- 日常开发改代码无需重新打包

代价：.app 依赖 `~/proxy-rebuild` 存在。删除仓库 = 应用无法启动（会弹错误框提示）。

## 使用

```bash
# 开发模式
cd desktop && npm install && npm start

# 构建 .app（输出到 desktop/dist-app/mac-arm64/）
npm run pack

# 安装
cp -R "dist-app/mac-arm64/Proxy Manager.app" /Applications/

# 卸载
#   1. 退出应用（Cmd+Q）
#   2. 把 /Applications/Proxy Manager.app 拖废纸篓
#   3. （可选）清数据: rm -rf ~/.multi-proxy-manager
```

## 进程语义（重要）

| 场景 | 行为 |
|------|------|
| manager 已在跑（manage.sh / LaunchAgent） | **附着模式**：只开窗口，退出不杀 |
| manager 没跑 | 壳拉起；Cmd+Q 时 SIGTERM→800ms→SIGKILL 回收 |
| 端口被占但探不通 | 弹窗报端口冲突 |
| codex/hermes/cursor 三代理 | 壳**绝不直接碰**，由 manager 管理 |

关红叉 ≠ 退出（macOS 惯例留在 Dock）；Cmd+Q 才真正退出。

## 环境变量

- `PROXY_MANAGER_REPO`：显式指定仓库根（默认 `~/proxy-rebuild`）
- 壳进程树内注入完整 PATH（~/.local/bin、homebrew 等，规避 GUI PATH 缺失）
- 仅壳进程树内设 `NO_PROXY=127.0.0.1,localhost,::1`——**绝不污染全局 launchd 环境**（CLAUDE.md 铁律）

## 已验证路径

- [x] 附着模式（manager 外部已跑 → 只开窗口）
- [x] 拉起模式（壳启动 manager → 200）
- [x] 退出回收（Cmd+Q / kill → manager 端口释放）
- [x] 打包版安装到 /Applications 双击启动全链路
