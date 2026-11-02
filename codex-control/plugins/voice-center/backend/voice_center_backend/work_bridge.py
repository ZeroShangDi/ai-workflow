"""Audio-session notifications only. Work execution and persistence live in WorkStore."""
import asyncio
import time
import uuid
from dataclasses import dataclass
from pipecat.frames.frames import (StartFrame, EndFrame, CancelFrame, TTSSpeakFrame, ControlFrame,
    UserStartedSpeakingFrame, UserStoppedSpeakingFrame, BotStartedSpeakingFrame, BotStoppedSpeakingFrame,
    LLMFullResponseStartFrame, LLMFullResponseEndFrame)
from pipecat.processors.frame_processor import FrameProcessor


@dataclass
class WorkNoticeEndFrame(ControlFrame):
    notice_id: str


class WorkAnnouncements(FrameProcessor):
    def __init__(self, connection, context, prepare_notice=None, on_close=None, notice_delivered=None):
        super().__init__()
        self.connection, self.context = connection, context
        self.pending = {}
        self.accepted = set()
        self.busy = False
        self.user_speaking = self.bot_speaking = self.llm_active = self.waiting_reply = False
        self.quiet_since = time.monotonic()
        self.loop = None
        self.speaking_notice = None
        self.prepare_notice = prepare_notice
        self.on_close = on_close
        self.notice_history = {}
        self.notice_delivered = notice_delivered

    def observe(self, frame):
        if isinstance(frame, UserStartedSpeakingFrame):
            self.user_speaking = self.waiting_reply = True
            self.notice_history.pop(self.speaking_notice, None)
            self.speaking_notice = None
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self.user_speaking = False
            self.quiet_since = time.monotonic()
        elif isinstance(frame, LLMFullResponseStartFrame):
            self.llm_active = True
        elif isinstance(frame, LLMFullResponseEndFrame):
            self.llm_active = False
        elif isinstance(frame, BotStartedSpeakingFrame):
            self.bot_speaking = True
            if not self.user_speaking: self.waiting_reply = False
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.bot_speaking = False
            self.quiet_since = time.monotonic()
        elif isinstance(frame, WorkNoticeEndFrame) and self.speaking_notice == frame.notice_id:
            self.speaking_notice = None
            self.quiet_since = time.monotonic()
            self.connection.send_app_message({'type':'task_notice_ack','id':frame.notice_id})
            text = self.notice_history.pop(frame.notice_id, None)
            if text:
                self.context.add_message({'role': 'assistant', 'content': f'后台工作汇报（记录标识 {frame.notice_id}）：{text}'})
                if self.notice_delivered:
                    self.notice_delivered(frame.notice_id)
        self.busy = self.user_speaking or self.bot_speaking or self.llm_active or self.waiting_reply

    def receive(self, message):
        if not isinstance(message, dict): return
        if message.get('type') == 'task_notice_cancel':
            if isinstance(message.get('id'), str): self.pending.pop(message['id'], None)
            return
        if message.get('type') != 'task_notice': return
        key, text = message.get('id'), message.get('text')
        if not isinstance(key,str) or len(key)>100 or not isinstance(text,str) or not 0<len(text)<=1000: return
        if key in self.accepted:
            return
        if len(self.pending) < 10: self.pending[key] = {'id': key, 'text': text}

    async def run_notices(self):
        while True:
            await asyncio.sleep(.3)
            if self.busy or self.speaking_notice or not self.pending or time.monotonic()-self.quiet_since<2: continue
            key = next(iter(self.pending)); notice = self.pending[key]
            if 'prepared' not in notice:
                try:
                    notice['prepared'] = await self.prepare_notice(notice) if self.prepare_notice else notice['text']
                except Exception:
                    notice['prepared'] = notice['text']
            # Summary generation can overlap a new user turn or host cancellation.
            if key not in self.pending or self.busy or time.monotonic()-self.quiet_since<2: continue
            self.pending.pop(key)
            text = notice['prepared']
            if not text:
                self.accepted.add(key)
                self.connection.send_app_message({'type':'task_notice_ack','id':key})
                continue
            self.busy=True; self.speaking_notice=key
            self.accepted.add(key)
            self.notice_history[key] = text
            # Result text is spoken as data, never executed as LLM instructions.
            await self.push_frame(TTSSpeakFrame(text=text))
            # TTS serializes this marker after all audio; output transport preserves that order.
            await self.push_frame(WorkNoticeEndFrame(notice_id=key))

    async def process_frame(self, frame, direction):
        await super().process_frame(frame,direction)
        self.observe(frame)
        if isinstance(frame,StartFrame) and self.loop is None:
            self.loop=asyncio.create_task(self.run_notices())
        if isinstance(frame,(EndFrame,CancelFrame)):
            await self.stop()
        await self.push_frame(frame,direction)

    async def stop(self):
        if self.on_close:
            self.on_close()
            self.on_close = None
        if self.loop:
            self.loop.cancel()
            await asyncio.gather(self.loop,return_exceptions=True)
            self.loop=None

    async def cleanup(self):
        await self.stop()
        await super().cleanup()


def proposal(prompt):
    if not isinstance(prompt,str) or not 0<len(prompt.strip())<=6000: raise ValueError('Invalid task')
    return {'type':'task_proposal','id':str(uuid.uuid4()),'prompt':prompt.strip()}
