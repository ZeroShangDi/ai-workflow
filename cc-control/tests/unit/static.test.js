import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStaticHost } from '../../src/server/static.cjs';

// T1-119：`defaultAliases()`（把 /diagnostics 等无扩展名路径映射到 legacy html）已随旧观测页退役删除。
// 本文件改用**中性的夹具名**，并把别名表显式传给 host —— 静态托管是通用原语，
// 页面归属由调用方（web 产物托管）决定，不该再有一套内置的「哪个路径对应哪个 html」。

const tmpDirs = [];
function tmpAssets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-static-'));
  tmpDirs.push(root);
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>index</h1>');
  fs.writeFileSync(path.join(root, 'page.html'), '<h1>page</h1>');
  fs.writeFileSync(path.join(root, 'app.js'), 'var a=1;');
  return root;
}
function fakeRes() {
  const res = {};
  res.writeHead = (code, headers) => { res.code = code; res.headers = headers; };
  res.end = (body) => { res.body = body; };
  return res;
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('createStaticHost — resolve', () => {
  const root = tmpAssets();
  const host = createStaticHost({ root, aliases: { '/': 'index.html', '/page': 'page.html' } });

  it('别名表由调用方显式给出；直接文件也可', () => {
    expect(host.resolve('/')).toBe(path.join(root, 'index.html'));
    expect(host.resolve('/page')).toBe(path.join(root, 'page.html'));
    expect(host.resolve('/app.js')).toBe(path.join(root, 'app.js'));
  });

  it('没给别名表 → 无扩展名路径不再被默认映射', () => {
    const bare = createStaticHost({ root });
    expect(bare.resolve('/page')).toBe(path.join(root, 'page.html')); // 靠「同 html 兜底」，不是别名表
    expect(bare.resolve('/app')).toBeNull();                          // 没有 app.html
  });

  it('无扩展名同 html 兜底（/foo → foo.html）；缺失 → null', () => {
    fs.writeFileSync(path.join(root, 'foo.html'), 'x');
    expect(host.resolve('/foo')).toBe(path.join(root, 'foo.html'));
    expect(host.resolve('/nope')).toBeNull();
  });

  it("越权 '..' 被拒；query/hash 剥离", () => {
    expect(host.resolve('/../etc/passwd')).toBeNull();
    expect(host.resolve('/page?x=1')).toBe(path.join(root, 'page.html'));
  });
});

describe('createStaticHost — serve', () => {
  const root = tmpAssets();
  const host = createStaticHost({ root, aliases: { '/': 'index.html', '/page': 'page.html' } });

  it('命中写 200 + 正确 MIME；未命中 false', () => {
    const res = fakeRes();
    expect(host.serve(null, res, '/page')).toBe(true);
    expect(res.code).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body.toString()).toContain('<h1>page</h1>');

    const res2 = fakeRes();
    expect(host.serve(null, res2, '/missing')).toBe(false);
    expect(res2.code).toBeUndefined();
  });

  it('js 文件 MIME text/javascript', () => {
    const res = fakeRes();
    expect(host.serve(null, res, '/app.js')).toBe(true);
    expect(res.headers['content-type']).toContain('text/javascript');
  });
});

describe('createStaticHost — SPA 产物托管（T1-093 web build→public）', () => {
  const root = tmpAssets();
  const host = createStaticHost({ root, aliases: { '/': 'index.html' }, spa: 'index.html' });

  it('/ 经别名给 index；assets 直接文件', () => {
    expect(host.resolve('/')).toBe(path.join(root, 'index.html'));
    expect(host.resolve('/app.js')).toBe(path.join(root, 'app.js'));
  });

  it('无扩展名前端路由 → SPA 回退 index；存在文件优先于回退；带扩展名缺失仍 null（不吞资源 404）', () => {
    expect(host.resolve('/wbs-tree')).toBe(path.join(root, 'index.html'));
    expect(host.resolve('/page')).toBe(path.join(root, 'page.html')); // 真实文件优先
    expect(host.resolve('/missing.js')).toBeNull();
  });
});
