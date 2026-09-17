# 环境与运行问题速查（ENV-NOTES）

> 本文档集中记录项目运行 / 测试环境相关问题与修复。
> 原沉淀于 `CLAUDE.md`（已归档，见 `docs/09-review/archive/CLAUDE.md`），随项目文档体系重构迁入此处（活跃运维文档）。

## 1. better-sqlite3 native module 版本不匹配

- **现象**：Cursor `database.test.ts` 测试全 fail。
- **根因**：`better-sqlite3` 预编译仅支持 Node 18（NODE_MODULE_VERSION 127），当前系统 Node 版本 ABI 不匹配。
- **修复**：
  ```bash
  cd cursor-proxy && npm rebuild better-sqlite3      # 或 npm install
  # 若 npm cache 目录无写权限：
  npm config set cache /tmp/npm-cache && npm rebuild better-sqlite3
  ```
- **现状**：cursor-proxy 测试需 `NODE_OPTIONS=--experimental-vm-modules`（ESM + ts-jest 设计，Node 24）；若 native 模块仍不匹配，按上 rebuild。

## 2. Manager supertest EPERM

- **现象**：Manager 测试中 supertest 发起 HTTP 请求时 `EPERM` 无法绑定 `0.0.0.0`。
- **根因**：沙箱 / 受限环境禁止绑定监听端口。
- **结论**：这是**环境问题，非代码 bug**。在正常本地环境或 Docker 中应可通过。
  本地若遇 EPERM，确认未处于沙箱限制、或换用可绑定端口的环境后重跑。

## 3. macOS pip 安装

- `install.sh` 中 `pip3 install` 在 macOS **不使用** `--break-system-packages`
  （该参数仅 Debian / Ubuntu 有效，macOS 上会报错）。

## 4. 关联文档

- 运维总索引：`docs/07-ops/`（runbook / deployment / rollback）
- ADR：`docs/03-adr/0001-lsof-absolute-path.md`、`0002-no-proxy-iron-law.md`
- 安全修复：`P0-FIXES.md`
- 完整架构与环境说明：`docs/03-architecture/architecture.md`
