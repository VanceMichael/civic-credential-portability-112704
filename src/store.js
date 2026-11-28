/**
 * 内存存储 + 只增审计日志。
 * 只负责集合的读写和追加，不含任何业务判定（业务判定在各领域模块）。
 */
import { iso } from './time.js';

const COLLECTIONS = [
  'regions',
  'centres',
  'actors',
  'ruleVersions',
  'policyNotices',
  'scores',
  'scoreRevisions',
  'exams',
  'examClaims',
  'certCases',
  'certificates',
  'certEvents',
  'shifts',
  'proofLetters',
  'letterImpacts',
  'auditLog',
];

export class Store {
  constructor() {
    for (const name of COLLECTIONS) this[name] = [];
    this._seq = 0;
  }

  nextId(prefix) {
    this._seq += 1;
    return `${prefix}-${this._seq.toString(36)}`;
  }

  /** 进程内单调序号，用于同一时点多条记录的稳定排序（不参与外部标识）。 */
  nextOrder() {
    this._order = (this._order ?? 0) + 1;
    return this._order;
  }

  add(collection, row) {
    if (!Array.isArray(this[collection])) throw new Error(`未知集合: ${collection}`);
    this[collection].push(row);
    return row;
  }

  find(collection, id) {
    return this[collection].find((row) => row.id === id) ?? null;
  }

  get(collection, id, label = collection) {
    const row = this.find(collection, id);
    if (!row) {
      const err = new Error(`${label} 不存在: ${id}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    return row;
  }

  list(collection) {
    return this[collection];
  }

  /**
   * 追加一条不可变审计记录。所有由外部参与者触发的状态变更都应留痕。
   */
  audit(actorId, action, target, detail = {}, at = new Date()) {
    const entry = {
      id: this.nextId('audit'),
      at: iso(at),
      actor: actorId,
      action,
      target,
      detail,
    };
    this.auditLog.push(entry);
    return entry;
  }

  snapshot() {
    const out = {};
    for (const name of COLLECTIONS) out[name] = structuredClone(this[name]);
    return out;
  }
}

/**
 * 从联调资料装载基础数据。规则版本、派生状态由 service 层在装载后构建。
 */
export function seedStore(store, data) {
  for (const region of data.regions ?? []) {
    store.add('regions', structuredClone(region));
  }
  for (const centre of data.centres ?? []) {
    store.add('centres', structuredClone(centre));
  }
  for (const score of data.scores ?? []) {
    store.add('scores', { ...structuredClone(score), receivedAt: score.receivedAt ?? null });
  }
  for (const revision of data.scoreRevisions ?? []) {
    store.add('scoreRevisions', { ...structuredClone(revision), order: store.nextOrder() });
  }
  for (const exam of data.exams ?? []) {
    store.add('exams', {
      ...structuredClone(exam),
      locked: false,
      lockedAt: null,
      lockedSubjects: null,
      lockedWorkers: null,
    });
  }
  for (const claim of data.examClaims ?? []) {
    store.add('examClaims', {
      citations: [],
      ...structuredClone(claim),
      status: 'reserved',
      decidedAt: null,
    });
  }
  for (const certificate of data.certificates ?? []) {
    store.add('certificates', { ...structuredClone(certificate), status: 'issued' });
    store.add('certEvents', {
      id: store.nextId('cev'),
      certificate: certificate.id,
      at: certificate.from,
      type: 'issued',
      detail: { scope: structuredClone(certificate.scope) },
    });
  }
  for (const shift of data.shifts ?? []) {
    store.add('shifts', structuredClone(shift));
  }
  for (const letter of data.proofLetters ?? []) {
    const certificate = data.certificates?.find((item) => item.id === letter.certificate);
    store.add('proofLetters', {
      ...structuredClone(letter),
      worker: letter.worker ?? certificate?.worker ?? null,
      status: letter.status ?? 'confirmed',
      gaps: letter.gaps ?? [],
      impacts: [],
    });
  }
  return store;
}
