#!/usr/bin/env node
// CCR 隔离实例管理脚本
// 用法: node scripts/ccr-dev-instance.cjs <start|stop|status|ui|env>
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..', '..');
const devHome = path.join(repoRoot, '.ccr-dev-home');
const distCli = path.join(repoRoot, 'dist', 'cli.js');
const configPath = path.join(devHome, '.claude-code-router', 'config.json');
const pidFile = path.join(devHome, '.claude-code-router', '.claude-code-router.pid');

function ensureDevHome() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing isolated config: ${configPath}`);
  }
}

function envWithDevHome() {
  return { ...process.env, HOME: devHome, USERPROFILE: devHome };
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function serviceUrl() {
  const config = readConfig();
  const host = config.HOST || '127.0.0.1';
  const port = config.PORT || 3456;
  return `http://${host}:${port}`;
}

function runCli(args, options = {}) {
  return spawn(process.execPath, [distCli, ...args], {
    cwd: repoRoot,
    env: envWithDevHome(),
    stdio: options.detached ? 'ignore' : 'inherit',
    detached: Boolean(options.detached),
  });
}

function start() {
  ensureDevHome();
  const child = runCli(['start'], { detached: true });
  child.unref();
  console.log(`Started isolated CCR at ${serviceUrl()}`);
}

function stop() {
  ensureDevHome();
  const child = runCli(['stop']);
  child.on('exit', (code) => process.exit(code ?? 0));
}

function status() {
  ensureDevHome();
  const child = runCli(['status']);
  child.on('exit', (code) => process.exit(code ?? 0));
}

function ui() {
  ensureDevHome();
  console.log(serviceUrl() + '/ui/');
}

function printEnv() {
  ensureDevHome();
  console.log(JSON.stringify({
    repoRoot,
    devHome,
    configPath,
    pidFile,
    serviceUrl: serviceUrl(),
  }, null, 2));
}

const command = process.argv[2];
switch (command) {
  case 'start': start(); break;
  case 'stop': stop(); break;
  case 'status': status(); break;
  case 'ui': ui(); break;
  case 'env': printEnv(); break;
  default:
    console.log('Usage: node scripts/ccr-dev-instance.cjs <start|stop|status|ui|env>');
    process.exit(command ? 1 : 0);
}
