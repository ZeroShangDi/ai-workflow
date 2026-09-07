import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStaticHost } from '../../src/server/static.cjs';

const tmpDirs = [];
function tmpAssets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-static-'));
  tmpDirs.push(root);
  fs.writeFileSync(path.join(root, 'dashboard.html'), '<h1>dashboard</h1>');
  fs.writeFileSync(path.join(root, 'ui.html'), '<h1>ui</h1>');
  fs.writeFileSync(path.join(root, 'diagnostics.html'), '<h1>diag</h1>');
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
  const host = createStaticHost({ root });

  it('UI 路径经默认别名解析到对应 html；直接文件也可', () => {
    expect(host.resolve('/')).toBe(path.join(root, 'dashboard.html'));
    expect(host.resolve('/ui')).toBe(path.join(root, 'ui.html'));
    expect(host.resolve('/diagnostics')).toBe(path.join(root, 'diagnostics.html'));
    expect(host.resolve('/app.js')).toBe(path.join(root, 'app.js'));
  });

  it('无扩展名同 html 兜底（/foo → foo.html）；缺失 → null', () => {
    fs.writeFileSync(path.join(root, 'foo.html'), 'x');
    expect(host.resolve('/foo')).toBe(path.join(root, 'foo.html'));
    expect(host.resolve('/nope')).toBeNull();
  });

  it("越权 '..' 被拒；query/hash 剥离", () => {
    expect(host.resolve('/../etc/passwd')).toBeNull();
    expect(host.resolve('/ui?x=1')).toBe(path.join(root, 'ui.html'));
  });
});

describe('createStaticHost — serve', () => {
  const root = tmpAssets();
  const host = createStaticHost({ root });

  it('命中写 200 + 正确 MIME；未命中 false', () => {
    const res = fakeRes();
    expect(host.serve(null, res, '/ui')).toBe(true);
    expect(res.code).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body.toString()).toContain('<h1>ui</h1>');

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
