import net from 'node:net';

/**
 * inbox socket 注入 — 向主会话投递一条用户消息（等价终端输入一条 prompt）。
 *
 * 线格式 NDJSON（`\n` 结尾）。macOS 写后延时再关（bundle 客户端同款行为）。
 * 参考：官方示例 `echo '{"type":"user","message":{"role":"user","content":"hello"}}' | socat - UNIX-CONNECT:<path>`
 */

/**
 * 向主会话注入一条文本指令。
 * @param {string} socketPath - inbox socket 路径（bootstrap 以 --messaging-socket-path 固定）
 * @param {string} text - 注入文本（作为用户消息）
 * @param {object} [opts] - { priority?: string, timeoutMs?: number }
 * @returns {Promise<void>}
 */
export function injectText(socketPath, text, { priority = 'next', timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection({ path: socketPath });
    let settled = false;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    conn.setTimeout(timeoutMs, () => {
      conn.destroy();
      done(() => reject(new Error(`inject timeout: ${socketPath}`)));
    });
    conn.on('connect', () => {
      const msg = {
        type: 'user',
        message: { role: 'user', content: text },
        priority,
      };
      conn.write(JSON.stringify(msg) + '\n');
      // macOS：写后延时再 end（让 server 读完）；其他平台可直接 end
      setTimeout(() => { conn.end(); }, 200);
    });
    conn.on('error', (e) => done(() => reject(e)));
    conn.on('close', () => done(() => resolve()));
  });
}
