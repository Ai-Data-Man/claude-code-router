#!/usr/bin/env node
/**
 * 增量构建 + 全局安装脚本
 * 检测 Git 变更，只构建有改动的包，最后 npm link 到全局
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..", "..");
const changedResult = execSync("git diff --name-only HEAD", {
  cwd: rootDir,
  encoding: "utf-8",
}).trim();

if (!changedResult) {
  console.log("ℹ️  无文件变更，跳过构建");
} else {
  const changedFiles = changedResult.split("\n");
  console.log(`📦 检测到 ${changedFiles.length} 个文件变更\n`);

  const changed = {
    shared: changedFiles.some((f) => f.startsWith("packages/shared/")),
    core: changedFiles.some((f) => f.startsWith("packages/core/")),
    server: changedFiles.some((f) => f.startsWith("packages/server/")),
    ui: changedFiles.some((f) => f.startsWith("packages/ui/")),
    cli: changedFiles.some((f) => f.startsWith("packages/cli/")),
  };

  const steps = [];

  // 1. shared — 无内部依赖，独立构建
  if (changed.shared) {
    steps.push("shared");
    // server 依赖 shared，shared 变了 server 也要重构建
    changed.server = true;
  }

  // 2. core — 无内部依赖
  if (changed.core) steps.push("core");

  // 3. server — 有 shared 变更也需要构建
  if (changed.server) steps.push("server");

  // 4. ui — 独立构建
  if (changed.ui) steps.push("ui");

  // 5. cli — 只要 server/ui/cli 任一有变更就需要重新打包
  if (changed.server || changed.ui || changed.cli) steps.push("cli");

  // 去重
  const uniqueSteps = [...new Set(steps)];
  console.log(`▶️  需要构建: ${uniqueSteps.join(" → ") || "(无)"}\n`);

  // 按依赖顺序构建
  const buildOrder = ["shared", "core", "server", "ui", "cli"];
  for (const pkg of buildOrder) {
    if (uniqueSteps.includes(pkg)) {
      const start = Date.now();
      console.log(`🔨 构建 ${pkg}...`);
      execSync(`pnpm build:${pkg === "cli" ? "cli" : pkg}`, {
        cwd: rootDir,
        stdio: "inherit",
      });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`✅ ${pkg} 构建完成 (${elapsed}s)\n`);
    }
  }
}

// 始终链接到全局
console.log("🔗 链接到全局 (npm link)...");
execSync("npm link", { cwd: rootDir, stdio: "inherit" });

// Verify npm link succeeded
try {
  const linked = execSync("npm ls -g --depth=0 @musistudio/claude-code-router 2>&1", {
    cwd: rootDir,
    encoding: "utf-8",
  });
  if (linked.includes("claude-code-router")) {
    console.log(`\n✅ 全局安装验证通过: @musistudio/claude-code-router 已链接`);
  } else {
    throw new Error("not found");
  }
} catch {
  console.error(`\n❌ 全局安装验证失败: npm link 可能未生效`);
  process.exit(1);
}
