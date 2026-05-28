---
name: ccr-build
version: 1.0.0
description: "CCR 增量构建 + 全局安装。检测 Git 变更只构建有改动的包，自动 npm link 到全局。当需要构建安装 CCR 时使用。"
user-invocable: true
---

# CCR 构建与全局安装技能

一键增量构建变更 + 全局安装。

## 触发方式

在项目根目录下使用：

```
ccr-build
```

或在 Claude Code 中提及"构建并安装"、"ccr 构建"、"build and link" 等关键词自动触发。

## 工作原理

### 增量构建

通过 `git diff --name-only HEAD` 检测变更，只构建有改动的包：

| 变更包 | 触发构建 | 级联构建 |
|--------|----------|----------|
| `packages/shared/` | shared | server（因为 server 依赖 shared） |
| `packages/core/` | core | — |
| `packages/server/` | server | cli（需要重新打包） |
| `packages/ui/` | ui | cli（需要重新打包） |
| `packages/cli/` | cli | — |

### 全局安装

始终执行 `npm link`，确保全局 `ccr` 命令指向最新构建产物。

### 验证

构建安装完成后自动运行 `ccr --help` 验证命令可用性。

## 依赖顺序

```
shared → server → cli
core   → (独立)
ui     → cli
```

`build:cli` 内部会打包 server + ui 产物，无需前置手动构建 server 和 ui。
