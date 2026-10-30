import { VoiceControlApp } from './app.mjs';
import { TriggerConfigStore } from './config.mjs';
import { createVoiceHttpServer } from './http.mjs';

function portFromEnvironment() {
  const raw = process.env.VOICE_CONTROL_PORT || '8791';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('VOICE_CONTROL_PORT must be an integer between 0 and 65535');
  }
  return port;
}

const host = process.env.VOICE_CONTROL_HOST || '127.0.0.1';
const port = portFromEnvironment();
const allowedOrigins = (process.env.VOICE_CONTROL_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const triggerConfigStore = new TriggerConfigStore();
triggerConfigStore.load();
const app = new VoiceControlApp({ triggerConfigStore });
const server = createVoiceHttpServer({ app, allowedOrigins });

server.on('error', (error) => {
  process.stderr.write(`voice-control failed to start: ${error.message}\n`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const address = server.address();
  const displayHost = typeof address === 'object' && address ? address.address : host;
  const displayPort = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(`voice-control listening on http://${displayHost}:${displayPort}\n`);
});

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`voice-control stopping (${signal})\n`);
  server.close((error) => {
    if (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
