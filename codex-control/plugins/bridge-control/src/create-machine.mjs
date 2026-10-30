import crypto from 'node:crypto';
import { isUnknownResult } from './hub-client.mjs';

const REQUIRED_DRAFT_FIELDS = Object.freeze(['project', 'request']);
const AFFIRMATIVE = /^(确认|确认创建|是的|是|好|可以|同意|对|yes|y|ok|okay|confirm|approve)[。.!！]?$/i;
const NEGATIVE = /^(否|不|不行|不用|不要|取消|no|n|cancel|reject)[。.!！]?$/i;

function freshId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function requiredFields(draft) {
  return REQUIRED_DRAFT_FIELDS.filter((field) => typeof draft[field] !== 'string' || !draft[field].trim());
}

function summaryFor(draft) {
  return `项目：${draft.project}\n任务：${draft.request}${draft.title ? `\n标题：${draft.title}` : ''}`;
}

function decisionFromTranscript(text) {
  const normalized = String(text || '').trim();
  if (AFFIRMATIVE.test(normalized)) return 'affirmative';
  if (NEGATIVE.test(normalized)) return 'negative';
  return 'ambiguous';
}

export class CreateDraftMachine {
  constructor({ createWork, latestUserTranscript, now = () => new Date(), idFactory = freshId }) {
    if (typeof createWork !== 'function') throw new TypeError('createWork must be a function');
    if (typeof latestUserTranscript !== 'function') throw new TypeError('latestUserTranscript must be a function');
    this.createWork = createWork;
    this.latestUserTranscript = latestUserTranscript;
    this.now = now;
    this.idFactory = idFactory;
    this.drafts = new Map();
  }

  publicDraft(draft) {
    const publicValue = {
      draftId: draft.draftId,
      binding: draft.binding,
      status: draft.status,
      draft: { ...draft.draft },
      summary: summaryFor(draft.draft),
      confirmationPrompt: draft.status === 'awaiting_confirmation'
        ? `请确认是否创建：${draft.draft.title || draft.draft.request}`
        : null,
      updatedAt: draft.updatedAt,
    };
    if (draft.status === 'needs_input') {
      publicValue.missing = requiredFields(draft.draft);
      publicValue.questions = publicValue.missing.map((field) => ({
        field,
        prompt: field === 'project' ? '要处理哪个项目？' : '需要完成什么任务？',
      }));
    }
    if (draft.outcome) publicValue.outcome = draft.outcome;
    if (draft.outcome === 'unknown') publicValue.writeStatus = 'unknown';
    if (draft.retryable === false) publicValue.retryable = false;
    if (draft.reconciliationRequired) publicValue.reconciliationRequired = true;
    if (draft.creation) publicValue.creation = draft.creation;
    return publicValue;
  }

  async transition(draft) {
    const missing = requiredFields(draft.draft);
    const nextStatus = missing.length ? 'needs_input' : 'awaiting_confirmation';
    if (nextStatus === 'awaiting_confirmation' && draft.baselineTurnId === undefined) {
      const transcript = await this.latestUserTranscript({ sessionId: draft.sessionId });
      draft.baselineTurnId = transcript?.turnId || transcript?.sequence || null;
      if (!draft.baselineTurnId) {
        throw new Error('Hub latestUserTranscript must provide turnId or sequence');
      }
    }
    draft.status = nextStatus;
    draft.updatedAt = this.now().toISOString();
    return this.publicDraft(draft);
  }

  async create({ sessionId, draft = {} }) {
    if (!sessionId) throw new Error('sessionId is required');
    const value = {
      draftId: this.idFactory('draft'),
      binding: this.idFactory('bind'),
      sessionId,
      draft: { ...draft },
      baselineTurnId: undefined,
      status: 'needs_input',
      outcome: null,
      retryable: null,
      reconciliationRequired: false,
      creation: null,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
    this.drafts.set(value.draftId, value);
    return this.transition(value);
  }

  async continue({ sessionId, draftId, binding, draft = {} }) {
    if (!sessionId || !draftId || !binding) {
      throw new Error('sessionId, draftId, and binding are required to continue a draft');
    }
    const current = this.drafts.get(draftId);
    if (!current || current.sessionId !== sessionId || current.binding !== binding) {
      return { status: 'stale', retryable: false, reconciliationRequired: true };
    }
    if (current.status === 'confirmed' || current.status === 'cancelled') {
      return this.publicDraft(current);
    }
    if (current.outcome === 'unknown') return this.publicDraft(current);
    current.draft = { ...current.draft, ...draft };
    current.outcome = null;
    current.retryable = null;
    current.reconciliationRequired = false;
    current.baselineTurnId = undefined;
    return this.transition(current);
  }

  async confirm({ sessionId, draftId, binding }) {
    const current = this.drafts.get(draftId);
    if (!current || current.sessionId !== sessionId || current.binding !== binding) {
      return { status: 'stale', retryable: false, reconciliationRequired: true };
    }
    if (current.outcome === 'unknown') return this.publicDraft(current);
    if (current.status === 'needs_input') {
      return { ...this.publicDraft(current), outcome: 'draft_incomplete', retryable: true };
    }
    if (current.status === 'cancelled') return this.publicDraft(current);
    if (current.status === 'confirmed') return this.publicDraft(current);

    const transcript = await this.latestUserTranscript({ sessionId });
    const turnId = transcript?.turnId || transcript?.sequence || null;
    if (!transcript?.text || !turnId || turnId === current.baselineTurnId) {
      return {
        ...this.publicDraft(current),
        outcome: 'confirmation_not_observed',
        retryable: true,
      };
    }
    const decision = decisionFromTranscript(transcript.text);
    if (decision === 'ambiguous') {
      return {
        ...this.publicDraft(current),
        outcome: 'confirmation_ambiguous',
        retryable: true,
      };
    }
    if (decision === 'negative') {
      current.status = 'cancelled';
      current.outcome = 'cancelled';
      current.updatedAt = this.now().toISOString();
      return this.publicDraft(current);
    }

    const idempotencyKey = `create:${current.draftId}:${turnId}`;
    let creation;
    try {
      creation = await this.createWork({
        idempotencyKey,
        draft: { ...current.draft },
        sessionId,
        transcript,
      });
    } catch (failure) {
      if (failure.code !== 'UNKNOWN_RESULT' && failure.code !== 'ETIMEDOUT') throw failure;
      creation = { status: 'unknown' };
    }
    if (isUnknownResult(creation)) {
      current.outcome = 'unknown';
      current.retryable = false;
      current.reconciliationRequired = true;
      current.updatedAt = this.now().toISOString();
      return {
        ...this.publicDraft(current),
        idempotencyKey,
        message: 'The create result is unknown. Reconcile state before retrying.',
      };
    }
    if (creation?.status === 'cancelled') {
      current.status = 'cancelled';
      current.outcome = 'cancelled';
    } else {
      current.status = 'confirmed';
      current.outcome = 'confirmed';
      current.creation = creation;
    }
    current.updatedAt = this.now().toISOString();
    return this.publicDraft(current);
  }
}
