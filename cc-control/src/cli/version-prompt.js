import fs from 'node:fs/promises';
import path from 'node:path';
import { select, input } from '@inquirer/prompts';

export async function promptVersion(cwd) {
  let current = '0.0.1';

  try {
    const state = JSON.parse(await fs.readFile(path.join(cwd, '.awf', 'state.json'), 'utf-8'));
    if (state.version) current = state.version;
  } catch {}

  if (current === '0.0.1') {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf-8'));
      if (pkg.version) current = pkg.version;
    } catch {}
  }

  const [major, minor, patch] = current.split('.').map(Number);

  const choices = [
    { name: `当前    ${current}`, value: current, description: '保持当前版本' },
    { name: `+patch  ${major}.${minor}.${Number(patch) + 1}`, value: `${major}.${minor}.${Number(patch) + 1}` },
    { name: `+minor  ${major}.${Number(minor) + 1}.0`, value: `${major}.${Number(minor) + 1}.0` },
    { name: `+major  ${Number(major) + 1}.0.0`, value: `${Number(major) + 1}.0.0` },
    { name: '自定义…', value: '__custom__', description: '手动输入版本号' },
  ];

  const answer = await select({
    message: '版本号',
    choices,
  });

  if (answer === '__custom__') {
    // 避免 select 残留的 stdin 事件干扰 input
    await new Promise((r) => setTimeout(r, 50));
    const custom = await input({
      message: '输入版本号',
      default: current,
      prefill: 'editable',
    });
    const trimmed = custom.trim();
    if (trimmed) return trimmed;
    return current;
  }

  return answer;
}
