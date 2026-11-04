// Qwen output playback and future affect/environment presentation stay in this module.
// The shared page supplies only generic message, state and delivery callbacks.
export function createRealtimeAudio({ send, onDelivery, onState, onError,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext } = {}) {
  let context = null;
  let closed = false;
  const playbacks = new Map();

  function finish(playback, status) {
    if (playback.finished) return;
    playback.finished = true;
    playbacks.delete(playback.id);
    for (const source of playback.sources) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
    }
    try { send({ type: 'realtime.playback.result', playbackId: playback.id, status }); }
    catch { onError('播放回执未能发送，通知状态以本地记录为准'); }
    if (playback.noticeId) onDelivery({ noticeId: playback.noticeId, status });
    onState('listening');
  }

  function check(playback) {
    if (playback.ended && !playback.sources.size) {
      finish(playback, playback.samples > 0 ? 'spoken' : 'failed');
    }
  }

  return {
    async prepare() {
      // Called from the user's start gesture, before network awaits.
      if (AudioContextImpl) {
        context = new AudioContextImpl({ sampleRate: 24000 });
        await context.resume();
      }
    },
    handle(value) {
      if (!value || typeof value.type !== 'string' || !value.type.startsWith('realtime.')) return false;
      if (closed) return true;
      const id = value.playbackId;
      if (typeof id !== 'string' || !id) return true;
      if (value.type === 'realtime.audio.start') {
        if (!playbacks.has(id)) {
          playbacks.set(id, { id, noticeId: value.noticeId || null, sources: new Set(), samples: 0, ended: false, finished: false,
            next: context?.currentTime || 0 });
        }
        return true;
      }
      const playback = playbacks.get(id);
      if (!playback) return true;
      try {
        if (value.type === 'realtime.audio.cancel') {
          finish(playback, value.status === 'failed' ? 'failed' : 'interrupted');
        } else if (value.type === 'realtime.audio.end') {
          playback.ended = true;
          check(playback);
        } else if (value.type === 'realtime.audio.delta' && !playback.ended) {
          if (!context || context.state !== 'running') throw new Error('音频播放未就绪，请重新打开语音');
          const bytes = Uint8Array.from(atob(value.audio), (c) => c.charCodeAt(0));
          if (!bytes.length || bytes.length % 2 || bytes.length > 48000) throw new Error('语音音频格式错误');
          const pcm = new DataView(bytes.buffer);
          const buffer = context.createBuffer(1, bytes.length / 2, 24000);
          const samples = buffer.getChannelData(0);
          for (let i = 0; i < samples.length; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
          playback.next = Math.max(context.currentTime + 0.02, playback.next);
          if (playback.next - context.currentTime > 30) throw new Error('语音播放积压，请重新打开语音');
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          playback.sources.add(source);
          playback.samples += samples.length;
          source.onended = () => {
            playback.sources.delete(source);
            source.disconnect();
            check(playback);
          };
          source.start(playback.next);
          playback.next += buffer.duration;
          onState('speaking');
        }
      } catch (error) {
        finish(playback, 'failed');
        onError(error.message);
      }
      return true;
    },
    close() {
      if (closed) return;
      // This is a host-observed stop. Report notices before closing the channel.
      for (const playback of [...playbacks.values()]) finish(playback, 'interrupted');
      closed = true;
      void context?.close();
      context = null;
    },
  };
}
