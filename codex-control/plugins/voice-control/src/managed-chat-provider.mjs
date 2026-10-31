function contentText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n').trim();
}

function latestUser(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return contentText(messages[index].content);
  }
  return '';
}

export class ManagedChatProvider {
  constructor({
    controlBridge,
    getVoiceSessionId,
    isAvailable = () => true,
    timeoutMs = 120000,
  }) {
    if (!controlBridge) throw new Error('controlBridge is required');
    if (typeof getVoiceSessionId !== 'function') throw new Error('getVoiceSessionId is required');
    this.controlBridge = controlBridge;
    this.getVoiceSessionId = getVoiceSessionId;
    this.isAvailable = isAvailable;
    this.timeoutMs = timeoutMs;
  }

  get available() {
    return Boolean(
      this.controlBridge.statusValue?.().connected
      && this.getVoiceSessionId()
      && this.isAvailable(),
    );
  }

  async reply(body) {
    const voiceSessionId = this.getVoiceSessionId();
    if (!voiceSessionId) throw new Error('managed voice session is not initialized');
    const text = latestUser(Array.isArray(body?.messages) ? body.messages : []);
    if (!text) throw new Error('a latest user message is required');
    const response = await this.controlBridge.request(
      'voice.chat.user',
      { voiceSessionId, text },
      {
        timeoutMs: this.timeoutMs,
        responseTopics: ['control.chat.reply', 'control.chat.failed', 'control.error'],
      },
    );
    if (response.topic !== 'control.chat.reply') {
      const error = new Error(response.payload?.message || 'Managed Codex chat failed');
      error.code = response.payload?.code || 'managed_chat_failed';
      throw error;
    }
    return {
      text: response.payload.text,
      messageId: response.payload.messageId || null,
      turnId: response.payload.turnId || null,
    };
  }
}
