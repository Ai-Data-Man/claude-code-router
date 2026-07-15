# Plan: 别名路由（sonnet / opus / fable / haiku）

> 状态：已实施（commit 历史因 .git 丢失而重建）
> 背景：Claude Code 最新版（v2.1.197+）的 `/model` 别名/ID（`claude-sonnet-5` / `claude-opus-4-8` / `claude-fable-5` / `claude-haiku-4-5-20251001`）在 CCR 中无法映射到对应路由，全部落到 `Router.default`，导致 `/model` 切换 fable/opus/sonnet 后实际走的模型不变。

## 目标

新增 `sonnet` / `opus` / `fable` / `haiku` 四个别名路由键，作为高于自动场景的主路由逻辑。原始分类（`background` / `think` / `longContext` / `webSearch` / `default`）全部保留作回退，**平滑升级**——存量配置原样可读。

## Claude Code 模型划分（取证）

来源：code.claude.com/docs/en/model-config、platform.claude.com（via anysearch）。

| 别名 | 解析的 model ID | 定位 |
|---|---|---|
| `sonnet` | `claude-sonnet-5` | 日常编码 |
| `opus` | `claude-opus-4-8` | 复杂推理 |
| `fable` | `claude-fable-5` | 最强，长任务 |
| `haiku` | `claude-haiku-4-5-20251001` | 轻量快速 |
| `best` | 有 Fable 用 Fable，否则最新 Opus | — |
| `opusplan` | plan 阶段 opus，执行阶段 sonnet | — |

## 根因

`packages/core/src/utils/router.ts` 的 `getUseModel`：当 `req.body.model` 不含逗号时，只有 `haiku` → `background`、`thinking` → `think` 两种映射，`sonnet`/`opus`/`fable` 全部落到 `Router.default`。

## 路由优先级（高 → 低，最终版）

1. `req.body.model` 含逗号 → 精确指定直通（原有）
2. longContext token 超阈值（原有）
3. CCR-SUBAGENT-MODEL 标签 → 直通（原有）
4. 🆕 **别名命中**：model 含 `claude` 且含 `fable`/`opus`/`sonnet`/`haiku` 关键字，且对应 Router 键有配置 → 走该键
5. haiku 关键字 → `background`（原有，兼容存量）
6. webSearch 工具特征（原有）
7. thinking 存在 → `think`（原有）
8. 兜底 `default`（原有）

> 别名命中低于 CCR-SUBAGENT-MODEL（保留子代理显式模型覆盖），高于 background/webSearch/think/default。

## 改动清单

| 层 | 文件 | 改动 |
|---|---|---|
| 核心 | `packages/core/src/utils/router.ts` | `getUseModel` 插入别名命中块 + `RouterScenarioType`/`RouterFallbackConfig` 扩展 |
| UI | `types.ts`/`ConfigProvider.tsx`/`Router.tsx`/`locales` | 四个新字段 + 中英文案 |
| CLI | `modelSelector.ts` | 主菜单 + 两处二级菜单 + 显示循环 |
| 文档 | `routing.md`/`CLAUDE.md`/`README_zh.md` | 别名路由小节与键说明 |

## 存量兼容

- `background` / `think` / `longContext` / `webSearch` / `image` / `longContextThreshold` 触发逻辑一行不动
- 三层 Router（session/project/global）浅合并自动覆盖新键
- `RouterFallbackConfig` 自动支持新 scenarioType
- `best` / `opusplan` / `sonnet[1m]` 解析到具体 ID 后自然命中

## 匹配规则

- 关键字：`fable` → `opus` → `sonnet` → `haiku`（无重叠，顺序不敏感，fable 优先稳妥）
- 守卫：`reqModel.includes('claude')` 避免非 Claude 模型误命中
- 仅在对应 Router 键有值时命中
- 空字符串 `''` / `undefined` → 静默回落

## 验证

1. `pnpm build` 全绿
2. 配 `Router.sonnet` = A；`/model sonnet` → 日志 `Using sonnet model for claude-sonnet-5`，走 A
3. `/model opus`（未配 Router.opus）→ 不命中别名，回落 default
4. 存量仅配 `background` 的配置 → 升级后原样生效
5. `/model haiku` 配了 Router.haiku → 走 haiku；没配但配了 background → 走 background（兼容）
