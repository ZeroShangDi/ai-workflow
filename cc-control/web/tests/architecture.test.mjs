import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
const root = resolve(import.meta.dirname, '../src');
const ALIAS = '@/';
const IMPORT_RE = /(?:from\s*|import\s*)['"]([^'"]+)['"]/g;
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? files(resolve(dir, entry.name))
      : /\.(jsx?|css)$/.test(entry.name)
        ? [resolve(dir, entry.name)]
        : [],
  );
}

/**
 * 把一条 import 说明符解析成「src 根相对路径」；裸包名（react 等）返回 null。
 *
 * `@/x` 是 src 根相对的别名（vite.config.js 与 scripts/alias-resolve.mjs 两处配的同一份），
 * `./x` / `../x` 按文件所在目录解析。
 * **必须认别名** —— 不认的话下面的护栏会把 `@/pages/...` 当裸包名跳过，页面互引就没人管了。
 */
function targetOf(file, specifier) {
  if (specifier.startsWith(ALIAS)) return specifier.slice(ALIAS.length);
  if (specifier.startsWith('.')) return relative(root, resolve(dirname(file), specifier));
  return null;
}

test('@/ 别名都指向真实文件', () => {
  const broken = [];
  for (const file of files(root)) {
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      if (!match[1].startsWith(ALIAS)) continue;
      if (!existsSync(resolve(root, targetOf(file, match[1]))))
        broken.push(`${relative(root, file)} → ${match[1]}`);
    }
  }
  assert.deepEqual(broken, [], `别名指向了不存在的文件:\n${broken.join('\n')}`);
});

test('shared dependencies point downward and pages do not import other pages', () => {
  for (const file of files(root)) {
    const path = relative(root, file);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const target = targetOf(file, match[1]);
      if (target === null) continue;
      if (path.startsWith('shared/'))
        assert.ok(
          target.startsWith('shared/') || target.startsWith('../../docs/design/'),
          `${path} imports ${target}`,
        );
      if (path.startsWith('shared/components/ui/'))
        assert.ok(
          !target.startsWith('shared/components/business/') && !target.startsWith('shared/api/'),
          `${path} imports business code`,
        );
      if (path.startsWith('pages/') && target.startsWith('pages/'))
        assert.equal(target.split('/')[1], path.split('/')[1], `${path} imports another page`);
    }
  }
});
test('only development bootstrap imports mock; pages do not contain mock data or transports', () => {
  for (const file of files(root)) {
    const path = relative(root, file),
      source = readFileSync(file, 'utf8');
    if (path === 'main.jsx') continue;
    assert.doesNotMatch(source, /(?:from\s*|import\s*\(?)["'][^"']*\/mock\//, path);
    assert.doesNotMatch(
      source,
      /\/mock\/(?:cc-work|interface-lab|new-product)|createMockServer|scenario=demo/,
      path,
    );
  }
});
