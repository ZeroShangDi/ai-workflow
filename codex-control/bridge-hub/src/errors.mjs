export class HubError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class CmbError extends Error {
  constructor(message, {
    code = 'cmb_error',
    status = 502,
    unknown = false,
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'CmbError';
    this.code = code;
    this.status = status;
    this.unknown = unknown;
  }
}

export function isWriteResultUnknown(error) {
  if (error?.unknown === true) return true;
  return new Set([
    'ABORT_ERR',
    'ECONNRESET',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
  ]).has(error?.code);
}

export function publicError(error) {
  if (error instanceof HubError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  if (error instanceof CmbError) {
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(error.unknown ? { result: 'unknown' } : {}),
      },
    };
  }
  if (error?.type === 'entity.too.large') {
    return { status: 413, body: { error: 'request body is too large', code: 'body_too_large' } };
  }
  return {
    status: 500,
    body: { error: 'internal hub error', code: 'internal_error' },
  };
}
