import { VoiceControlApp } from './app.mjs';
import { createChatProvider } from './chat-provider.mjs';
import { TriggerConfigStore } from './config.mjs';
import { createVoiceHttpServer } from './http.mjs';
import { loadVoiceIntegrationConfig } from './integration-config.mjs';
import { LocalVoiceEvents, TaskEventInbox } from './local-events.mjs';
import { NoticeStore } from './notice-store.mjs';
import path from 'node:path';
import { createOpenAICompatibleProxy } from './llm-proxy.mjs';
import { createWebSearchProvider } from './search.mjs';
import { createVoiceWebRtcTransport } from './webrtc.mjs';
import { ControlWebSocketClient } from './control-ws-client.mjs';
import { VoiceIntegrationCoordinator } from './integration-coordinator.mjs';
import { ManagedChatProvider } from './managed-chat-provider.mjs';

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
let integrationConfig = loadVoiceIntegrationConfig();
const localEvents = new LocalVoiceEvents({
  taskFile: integrationConfig.eventFiles.taskEvents,
});
const noticeStore = new NoticeStore({ filePath: path.join(dataDir, 'notices.json') });
const chatProvider = createChatProvider();
const audioTransport = createVoiceWebRtcTransport();
const searchProvider = createWebSearchProvider();
let controlBridge = null;
const controlConfig = integrationConfig.plugins.control;
const controlUrl = process.env.VOICE_CONTROL_CONTROL_WS_URL || controlConfig.websocketUrl;
const controlTokenFile = process.env.VOICE_CONTROL_CONTROL_WS_TOKEN_FILE || controlConfig.tokenFile;
if (controlUrl && controlTokenFile) {
  controlBridge = new ControlWebSocketClient({
    url: controlUrl,
    tokenFile: controlTokenFile,
    clientVersion: '0.3.0',
    onEvent: (event) => {
      const taskEvent = event.payload;
      if (
        taskEvent
        && typeof taskEvent === 'object'
        && ['task.', 'interaction.', 'artifact.'].some((prefix) => event.topic.startsWith(prefix))
      ) {
        const localEvent = { ...taskEvent };
        if (localEvent.sessionId === integrationConfig.workspace.voiceSessionId) {
          delete localEvent.sessionId;
        }
        try { app.tunnel(localEvent); } catch (failure) {
          process.stderr.write(`voice-control rejected control event: ${failure.message}\n`);
        }
      }
    },
  });
}
const managedChatProvider = controlBridge
  ? new ManagedChatProvider({
    controlBridge,
    getVoiceSessionId: () => integrationConfig.workspace.voiceSessionId,
    isAvailable: () => integrationConfig.workspace.initialized === true,
    timeoutMs: 120000,
  })
  : null;
const llmProxy = createOpenAICompatibleProxy({ searchProvider, managedChatProvider });
const app = new VoiceControlApp({
  triggerConfigStore,
  chatProvider,
  noticeStore,
  audioTransport,
  llmProxy,
  integrationConfig,
  controlBridge,
});
const integrationCoordinator = new VoiceIntegrationCoordinator({
  configPath: integrationConfig.configPath,
  controlBridge,
  initializationTimeoutMs: 120000,
  requestTimeoutMs: controlConfig.requestTimeoutMs,
  onConfig: (value) => {
    integrationConfig = value;
    app.integrationConfig = value;
  },
});
app.integrationCoordinator = integrationCoordinator;
const inbox = new TaskEventInbox({
  taskFile: integrationConfig.eventFiles.taskEvents,
  onEvent: (event) => app.tunnel(event),
});
inbox.start();
controlBridge?.start();
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
  controlBridge?.stop();
  server.close((error) => {
    if (error) {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
