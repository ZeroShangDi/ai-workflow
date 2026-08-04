'use strict';

// 测试注入点：vitest 无法 mock 被原生 require 的 CJS 依赖，提供显式注入钩子。
// 生产环境不设置 global.__CC_EXEC_FILE_SYNC__，回落到 child_process。
const execFileSync = global.__CC_EXEC_FILE_SYNC__ || require('child_process').execFileSync;

const SESSION = process.env.CC_SESSION || 'cc';

function tmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

function hasSession() {
  try {
    tmux(['has-session', '-t', SESSION]);
    return true;
  } catch {
    return false;
  }
}

// Send literal text (no tmux key interpretation), e.g. the message body.
function sendText(text) {
  tmux(['send-keys', '-t', SESSION, '-l', text]);
}

// Press Enter to submit the current input.
function sendEnter() {
  tmux(['send-keys', '-t', SESSION, 'Enter']);
}

// Read the current pane content (debug snapshot only).
function capture() {
  return tmux(['capture-pane', '-t', SESSION, '-p']);
}

module.exports = { SESSION, hasSession, sendText, sendEnter, capture };
