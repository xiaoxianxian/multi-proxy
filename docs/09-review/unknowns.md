# 未知/待补清单（unknowns）

> 收口时汇总"已知但未决/未验"项，避免遗漏。生成日期 2026-09-17（HEAD `57c2774`）。
> 原则：诚实标注，不臆造。区分「有意保留」与「需处理」。

---

## 一、待补真实信号（商业向，需老板输入）

| # | 未知项 | 来源 | 处置 |
|---|--------|------|------|
| U1 | 市场大小 & 付费意愿 | `commercialization-decided.md` / `PRD.md` §开放 | 未做客户访谈，**不下结论**；先用开源 + DSH 验证需求 |
| U2 | DSH 生态时间线 | `dsh-integration.md` | DSH 0.2 未稳定，DS2/DS3（发 npm）暂缓 |
| U3 | P5 桌面壳后续投入 | `PRD.md` §开放 | P5 已闭环，需老板定后续 |

---

## 二、功能待实现（路线图内，非缺陷）

| # | 未知项 | 现状 | 路线图 |
|---|--------|------|--------|
| U4 | 任务类型智能派发 D4 | `CLAUDE.md` L97「规划中/未实现」 | `ITERATION-ROADMAP` 方向四；扩展 `getNextRoute` 签名 + 加消息/任务上下文入口 |
| U5 | 记忆二期 / 技能二期接线 | `architecture.md` P1.1b/P2 | 内核已落地，API 路由 + 持久化 store 列后续（YAGNI） |
| U6 | 路由规则 evaluate | `CLAUDE.md` L97 `RouteConfig.rules` 已声明未 evaluate | 同 U4 |

---

## 三、幽灵路径（挂账，非当前 bug）

| # | 项 | 为何挂账 |
|---|----|----------|
| U7 | C2 `forward.js` 不支 SSE | manager 当前不代理 chat 流 → latent；改了 = 反向坑（"修好实际没改"） |
| U8 | B7 120s 掐断长流 | 同上，线上无人用，待 live 复现定夺 |

依据：`l2/PERF-REPORT.md §3`。

---

## 四、一致性待处理

| # | 项 | 处置 |
|---|----|------|
| U9 | `CLAUDE.md` L53-65 旧测试数 556/63/126 | 受保护文件，建议加注「以 MEMORY §13.11 为准」，不动数字 |

---

## 五、收口判定

| 类别 | 数量 | 判 |
|------|------|----|
| 商业待信号（U1-U3） | 3 | 需老板，非阻塞 |
| 功能待实现（U4-U6） | 3 | 路线图内，非缺陷 |
| 幽灵路径（U7-U8） | 2 | 挂账，非当前 bug |
| 一致性（U9） | 1 | 建议加注 |

**总判定**：无未决缺陷阻塞交付。所有 unknown 均为「有意保留 / 路线图内 / 需老板信号」，已诚实标注。

---

## 数据源

- 商业待信号：`commercialization-decided.md` / `PRD.md` / `dsh-integration.md`
- 功能待实现：`CLAUDE.md §开发注意` / `ITERATION-ROADMAP`
- 幽灵路径：`l2/PERF-REPORT.md §3`
- 一致性：`docs/09-review/consistency-report.md`
