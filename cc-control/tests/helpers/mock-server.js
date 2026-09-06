import http from 'http';

export function createMockServer({ statusCode = 200, responseBody = {}, onRequest } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (onRequest) {
        onRequest(req, body);
      }

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });

  const listen = (port = 0) =>
    new Promise((resolve, reject) => {
      server.listen(port, () => {
        const addr = server.address();
        resolve({ url: `http://localhost:${addr.port}`, port: addr.port });
      });
      server.on('error', reject);
    });

  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });

  return { server, listen, close };
}

export function mockHttpRequests() {
  // Track requests for assertions
  const requests = [];

  const mockGet = vi.fn((url) => {
    requests.push({ method: 'GET', url });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });

  const mockPost = vi.fn((url, body) => {
    requests.push({ method: 'POST', url, body });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });

  return { mockGet, mockPost, requests };
}
