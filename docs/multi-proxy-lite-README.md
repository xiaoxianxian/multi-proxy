# multi-proxy-lite · 本地 AI 网关镜像（轻档 MVP）

> 一句话：**把本地 AI 代理这层 + 本地引擎接入，打包成一个开箱即用的 Docker 镜像，数据不出本地。**
> 定位：本地算力 / 数据主权 / 账本主权的本地 AI 网关。个人与小微团队拉起来就能用。

## 内置了什么

| 件 | 作用 | 现状 |
|----|------|------|
| multi-proxy-manager 调度层 | 多模型统一代理、用量归一自动识别、base_url 单一所有、本地是一档路由条件（privacy→127.0.0.1） | 已建，manager 测试全绿 |
| L2 h3web 适配器 | 本地 AIGC/生成能力路由（零依赖 node http/net，端口 8731/8732） | 已实现+已测 |
| 接本地 Ollama | `host.docker.internal:11434`，本地算力（如 qwen3 系列） | 用户本地 Ollama |
| 判据探针 | `h3web-roundtrip-probe.js` + `--precheck` 一键判 GO/NO-GO（内存/Ollama/h3web） | 已就绪 |

**不含**：h3 重引擎（百 GB 权重 + GPU）——本地视频/AIGC 生成走「重量档」`multi-proxy-h3` 另出，不强制带进轻档。

## 怎么跑

```bash
# 一键（需 Docker 源可达；国内源 403 时用 legacy build 绕）
docker compose -f docker-compose.lite-mvp.yml up -d --build
# 或国内源卡 buildkit 时（本地有 node:20-alpine cache）：
DOCKER_BUILDKIT=0 docker build -f Dockerfile.lite-mvp -t multi-proxy-lite-mvp .
docker run -d --name multi-proxy-lite -p 18792:18792 \
  -e BIND_HOST=0.0.0.0 -e PROXY_L2_SKILL=1 \
  -e OLLAMA_BASE=http://host.docker.internal:11434 \
  --add-host=host.docker.internal:host-gateway multi-proxy-lite-mvp
```

## 判据（轻档 GO）

`manager :18792 HTTP 200` 且 `本地 Ollama :11434 HTTP 200`（`h3web precheck` 可选，仅 :8731 在听才跑）。`scripts/lite-mvp-smoke.sh` 一键验。

## 安全（对外部署必做）

- 管理台默认 `BIND_HOST=0.0.0.0`（Docker 部署 host 可达）→ **必须设 `MANAGER_PASSWORD`**（管理台 JWT 鉴权），并加防火墙/反向代理访问控制（启动 `[security]` 会提示）。
- 本地数据：multi-proxy 只管"过它这一跳"的流量，出网管控维度见 #83 号文（进程×目的地×体量），别只拦 AI 域名。

## 许可

- 开源：**AGPL-3.0**（源码）。
- 商用：见 `LICENSE-COMMERCIAL.md`（企业商用走商业授权，与开源双轨）。

## 诚实边界

- 「支持本地模型」不是差异项（云网关也有），差异在 **本地这一档路由条件 + 账本主权（记录记在你机器上、你说了算）**。
- 未做：MCP 统一管理、内容过滤（明写不吹）。
