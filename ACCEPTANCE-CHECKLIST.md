# Proxy Rebuild v1.0.0 — 验收准备

## 前置要求

```bash
# 检查 Node.js（≥ 16）
node --version

# 检查 Python3（≥ 3.8）
python3 --version

# 如果没有，安装
brew install node python
```

## 一键安装

```bash
cd proxy-rebuild
bash install.sh --all
```

## 配置 API Key

```bash
# Codex / Hermes
nano codex-proxy/.env
nano hermes-proxy/.env

# Cursor
nano cursor-proxy/.env
```

## 启动所有服务

```bash
bash manage.sh start
```

## 打开管理面板

浏览器访问：`http://localhost:18792`

首次访问会引导设置管理员密码。

## 验收测试

```bash
# Manager
cd multi-proxy-manager && NODE_ENV=test npx jest --verbose --forceExit

# Codex
cd codex-proxy && NODE_ENV=test npx jest --verbose --forceExit

# Hermes
cd hermes-proxy && PYTHONPATH=. python3 -m pytest tests/ -v

# Cursor
cd cursor-proxy && NODE_OPTIONS='--experimental-vm-modules' npx jest --verbose
```

预期结果：**549/549 全部通过**

## 验收清单

| 检查项 | 预期结果 |
|--------|---------|
| 所有服务启动成功 | `manage.sh status` 显示 4 个 ✓ |
| 管理面板可访问 | `http://localhost:18792` 正常打开 |
| 登录/登出正常 | 设置密码后登录，侧边栏底部有登出按钮 |
| 代理启停按钮 | Dashboard 页面对各代理点击启停有效 |
| 日志查看 | Logs 页面能看到各代理日志 |
| 供应商配置 | Proxy Config 页面能查看/编辑供应商 |
| 暗色模式 | 侧边栏底部有暗色模式切换按钮 |
| 移动端适配 | 小屏幕侧边栏可折叠 |
| 全部测试通过 | 549/549 tests pass |

## 常见问题

- 代理显示"未运行"：`/usr/sbin/lsof -i :18790` 测试 lsof 是否可用
- 代理启动失败：`bash manage.sh logs codex` 查看日志
- 忘记密码：`rm ~/.multi-proxy-manager/password && bash manage.sh restart manager`
