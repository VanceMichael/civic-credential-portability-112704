/**
 * 业务错误。HTTP 层据此映射状态码，领域层不感知传输协议。
 */
export class DomainError extends Error {
  constructor(code, message, status = 422, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export class ValidationError extends DomainError {
  constructor(message, details) {
    super('VALIDATION_ERROR', message, 422, details);
  }
}

export class NotFoundError extends DomainError {
  constructor(message) {
    super('NOT_FOUND', message, 404);
  }
}

export class PermissionError extends DomainError {
  constructor(message) {
    super('PERMISSION_DENIED', message, 403);
  }
}

export class ConflictError extends DomainError {
  constructor(message, details) {
    super('CONFLICT', message, 409, details);
  }
}
