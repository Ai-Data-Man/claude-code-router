---
name: ccr-debug
version: 1.1.0
description: "CCR 项目调试技能。构建、隔离实例启停、scoped config API 验证、浏览器 UI 联调。当需要验证 CCR 功能、调试 scoped config、测试 UI 交互时使用。"
user-invocable: true
---

# CCR 调试技能

## 两种调试模式

### 模式一：独立 Claude Code（默认）

用隔离实例单独验证 CCR 功能，不连接任何 Claude Code 会话。适合验证 API、UI、配置读写。

管理脚本 `scripts/ccr-dev-instance.cjs`：

```
node scripts/ccr-dev-instance.cjs start|stop|status|env
```

HOME 指向 `.ccr-dev-home`，CLAUDE_PROJECTS_DIR 指向用户真实目录 `~/.claude/projects`。这样 scoped config 写到隔离路径，但项目发现能读到真实会话。

### 模式二：用户本地 Claude Code 联调

用户改本地 Claude Code 配置指向测试实例（3479），用真实项目（如 `D:\SzztRepo\egova-v22-cas-oauth`）发起 Claude Code 会话，验证路由决策是否走了项目/会话级覆盖。

启动命令同模式一。关键区别是验证方式：
- 模式一：curl + agent-browser 验证 API 和 UI
- 模式二：用户在本地 Claude Code 里发请求，观察路由日志确认覆盖生效

验证项目覆盖是否被路由器读取：路由器通过 `searchProjectBySession(sessionId)` 扫描 `~/.claude/projects/{folderName}/{sessionId}.jsonl` 反查项目目录名，然后读 `HOME_DIR/{folderName}/config.json`。只要 `CLAUDE_PROJECTS_DIR` 指向真实路径，路由器就能找到会话对应的项目覆盖。

## 隔离原理

通过覆盖 `HOME`/`USERPROFILE` 让 `HOME_DIR`（`~/.claude-code-router`）指向 `.ccr-dev-home`，PID、config、日志、scoped 覆盖全部隔离。`CLAUDE_PROJECTS_DIR` 单独指向真实 `