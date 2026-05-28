# Claude Code Router (Fork)

> 本仓库为 [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) 的维护分支。

**原作者 README**: https://github.com/musistudio/claude-code-router/blob/main/README.md

## 与原项目的差异

本 fork 在原作者基础上新增和维护以下功能：

### 分层配置体系

- **三级作用域**: 全局 / 项目 / 会话三级配置，支持 Router、Provider 启用/禁用的逐层覆盖
- **Provider 模型管理**: 支持 `enabled` 字段控制 Provider 和模型级别的启用/禁用，支持 `models_path` 自定义模型列表获取路径
- **Web UI 支持**: ConfigProvider、Router、Providers 组件支持作用域切换，新增 ProjectDrawer/SessionDrawer/ScopeTabs/ViewTabs 子组件

### 空响应重试机制

- 当 LLM 返回空内容时按配置自动重试，支持 `enabled`/`maxAttempts`/`backoffMs` 配置项

### 日志管理增强

- **LOG_MAX_SIZE**: 新增日志总大小限额配置，启动时自动清理超限历史日志，支持 B/K/M/G 单位

### XML Tool Call 解析

- 将 LLM 输出中的 `<tool_call>` XML 格式工具调用自动转换为 OpenAI 兼容的 `tool_calls` 格式

### ToolCallSanitizer 与会话熔断

- 自动检测并抑制畸形 tool_use 块（空名称或 `tool_N` 回退名称）
- 同一会话连续畸形工具调用达阈值时自动剥离 tools 字段，中断错误循环

### Image Agent 重构

- 三阶段图片收集（cache/消息扫描/原始提取）、全局 key 兜底、SSE 流式 agent 响应
- 增强可观测性：嵌套 agent 流诊断指标

### 问题修复

- 修复 `tool_choice="required"` 与 thinking 冲突导致 400 错误
- 修复 provider/model 匹配时 `typeof` 类型守卫缺失导致的 `d.toLowerCase is not a function` 错误
- 修复 reasoning transformer 中 thinking → reasoning_content 回传缺失导致的 DeepSeek 400 错误
- 修复 thinking-signature 与 tool_calls 在 SSE 流中的分离问题
- 修复 Windows 主机无法检测 WSL 中 Claude Code 项目目录
- 修复项目级路由配置读取错误的 config 目录
- 修复日志防膨胀未能实际生效的问题

### 开发工具集

- **隔离实例脚本** (`scripts/ccr-dev-instance.cjs`): 通过 HOME 环境变量隔离开发实例
- **ccr-build 技能**: 增量构建 + 全局安装
- **ccr-debug 技能**: 隔离实例启停、scoped config API 验证

## 同步上游

```bash
git fetch upstream
git merge upstream/main
```
