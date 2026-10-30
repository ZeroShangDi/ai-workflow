import { VoiceControlApp } from './app.mjs';
import { createChatProvider } from './chat-provider.mjs';
import { TriggerConfigStore } from './config.mjs';
import { createVoiceHttpServer } from './http.mjs';
import { defaultEventDirectory, LocalVoiceEvents, TaskEventInbox } from './local-events.mjs';
import { NoticeStore } from './notice-store.mjs';
import path from 'node:path';

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
const dataDir = process.env.VOICE_CONTROL_DATA_DIR
  ? path.resolve(process.env.VOICE_CONTROL_DATA_DIR)
  : path.resolve(import.meta.dirname, '..', 'data');
const localEvents = new LocalVoiceEvents({ eventDir: defaultEventDirectory() });
const noticeStore = new NoticeStore({ filePath: path.join(dataDir, 'notices.json') });
const chatProvider = createChatProvider();
const app = new VoiceControlApp({
  triggerConfigStore,
  chatProvider,
  noticeStore,
  transcriptRecorder: (value) => localEvents.appendTranscript(value),
});
const inbox = new TaskEventInbox({
  eventDir: defaultEventDirectory(),
  onEvent: (event) => app.tunnel(event),
});
inbox.start();
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
  inbox.stop();
  server.close((error) => {
    if (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
