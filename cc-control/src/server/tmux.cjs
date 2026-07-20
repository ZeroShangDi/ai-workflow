'use strict';

const { execFileSync } = require('child_process');

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

// Send named keys, space-separated: "Escape", "C-c", "Up Up Enter".
function sendKeys(keys) {
  const parts = String(keys).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return;
  tmux(['send-keys', '-t', SESSION, ...parts]);
}

// Read the current pane content (debug snapshot only).
function capture() {
  return tmux(['capture-pane', '-t', SESSION, '-p']);
}

module.exports = { SESSION, hasSession, sendText, sendEnter, sendKeys, capture };
