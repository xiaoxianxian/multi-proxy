# 回滚指南（rollback）

> 提炼自 `manage.sh`、`CLAUDE.md`、`docker-compose.yml`。
> 生成日期：2026-09-17。

---

## 一、回滚场景

### 1.1 代理升级后启动失败

```bash
# 方式 1：manage.sh 重启（自动 rebuild native module）
./manage.sh restart cursor

# 方式 2：手动回滚（保留备份）
cd cursor-proxy
cp -r node_modules /tmp/cursor-node-modules-backup
npm rebuild better-sqlite3
# 若 rebuild 失败：
rm -rf node_modules && npm install
npm rebuild better-sqlite3
```

### 1.2 门控开关导致异常

```bash
# 关闭所有 L2 门控开关（回退到 shadow 状态）
sed -i.bak 's/PROXY_ORCHESTRATION=1/PROXY_ORCHESTRATION=0/' multi-proxy-manager/.env
sed -i.bak 's/PROXY_HEALTH_ALERT=1/PROXY_HEALTH_ALERT=0/' multi-proxy-manager/.env
sed -i.bak 's/PROXY_COST_TRACK=1/PROXY_COST_TRACK=0/' multi-proxy-manager/.env
sed -i.bak 's/PROXY_LLM_DECOMPOSE=1/PROXY_LLM_DECOMPOSE=0/' multi-proxy-manager/.env
./manage.sh restart manager
```

### 1.3 路由配置损坏（M6 override 导致请求异常）

```bash
# 关闭 M6 路由覆盖
sed -i.bak 's/PROXY_ROUTE_OVERRIDE=1/PROXY_ROUTE_OVERRIDE=0/' multi-proxy-manager/.env
./manage.sh restart manager

# 验证：访问 http://localhost:18792 查看审计日志，确认路由回退默认
curl -s http://localhost:18792/api/audit-log | head -20
```

### 1.4 路由数据库损坏（better-sqlite3）

```bash
# 备份 + 重建
cp cursor-proxy/data/proxy.db /tmp/proxy.db.backup
# 删除损坏 db（cursor-proxy 启动时自动重建空 schema）
rm cursor-proxy/data/proxy.db
./manage.sh restart cursor
# 验证
curl -s http://localhost:18794/api/providers | head -5
```

### 1.5 Manager 进程卡死

```bash
# 强制终止
pkill -9 -f "node.*server.js\|node.*multi-proxy-manager"
./manage.sh start manager

# 查看日志确认
cat ~/logs/multi-proxy-manager/manager.log | tail -50
```

---

## 二、Docker 模式回滚

```bash
# 回退到上一个镜像版本（tag 管理）
docker compose down
docker tag multi-proxy/manager:latest multi-proxy/manager:current
docker tag multi-proxy/manager:prev   multi-proxy/manager:latest
docker compose up -d
docker compose ps
```

---

## 三、配置文件回滚

| 场景 | 备份文件 | 恢复 |
|------|----------|------|
| M6 路由配置变更 | `routing-mode.json.bak` | `mv routing-mode.json.bak routing-mode.json && ./manage.sh restart cursor` |
| 供应商配置变更 | `providers.json.bak` | 同上 |
| manager .env 变更 | `multi-proxy-manager/.env.bak` | `cp .env.bak .env && ./manage.sh restart manager` |

---

## 四、回滚检查清单

| 步骤 | 检查 |
|------|------|
| 1 | 门控开关已回退到 `0` |
| 2 | `curl http://localhost:18792/api/auth/status` 返回正常 |
| 3 | `./manage.sh status` 显示 4 个代理全部运行 |
| 4 | `curl http://localhost:18794/api/providers` 返回供应商列表 |
| 5 | `cat ~/logs/multi-proxy-manager/*.log \| tail -20` 无 ERROR |
| 6 | `npx jest --silent \| tail -3` 635/635 全绿 |

---

## 五、事故记录

| 日期 | 事件 | 原因 | 处理 |
|------|------|------|------|
| 2026-09-17 | （无） | — | — |
| 2026-07-03 | P0 安全漏洞 | 通配符路由绕过 | 已修，见 `P0-FIXES.md` |

---

## 数据源

- `manage.sh`（启停/重启机制）
- `CLAUDE.md §P0 安全修复记录`
- `docs/04-business/commercialization-decided.md` M6 门控
- `docker-compose.yml`
