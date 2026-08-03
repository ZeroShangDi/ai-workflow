'use strict';
const fs = require('fs');
const path = require('path');

const SEP = '─'.repeat(60) + '\n';

function createRunLog(projectRoot, version) {
  const dir = path.join(projectRoot, '.awf', 'logs');
  fs.mkdirSync(dir, { recursive: true });

  const logPath = path.join(dir, `${version}.log`);

  const header = [
    '=== AWF Run Log ===\n',
    `version: ${version}\n`,
    `started: ${new Date().toISOString()}\n`,
    `project: ${projectRoot}\n`,
    '\n',
  ].join('');

  fs.writeFileSync(logPath, header);
  return logPath;
}

function appendLog(logPath, entry) {
  if (!logPath) return;

  const ts = new Date().toISOString().slice(11, 19);
  let content = '';

  switch (entry.type) {
    case 'PROMPT':
      content = SEP + `[${ts}] 提示词\n${entry.body || ''}\n\n`;
      break;
    case 'RESPONSE':
      content = `[${ts}] 回答\n${entry.body || ''}\n`;
      break;
    case 'CHOICE':
      content = `[${ts}]\nQ: ${entry.question}\nA: ${entry.answer}\n`;
      break;
    default:
      content = `[${ts}]\n${entry.body || ''}\n`;
  }

  try {
    fs.appendFileSync(logPath, content);
  } catch (err) {
    console.error(`[log-writer] write error: ${err.message}`);
  }
}

module.exports = { createRunLog, appendLog };
