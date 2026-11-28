/**
 * 证照签发与依据管理。
 *
 * 发证材料 certCase 状态：
 *   complete（材料完整）/ incomplete（暂缓，有待定科目）/ rejected（拒签）
 *   / issued（已签发）/ closed（已结案，含拒签或被替代）
 *
 * 证照 certificate 状态：
 *   issued（有效）/ suspended（暂停核验）/ invalid（确认不成立，留档不删除）
 *
 * 核心规则：
 *  - 外区成绩撤销、复核推翻单科，只有 scope 依赖该成绩的证照进入暂停核验；
 *  - 新成绩替代失效依据时，按「当次签发」适用的规则条款重新核查，
 *    不能无条件把任意一次通过拼成一张证；
 *  - 已确认不成立的证照记录保留，授权方可核查；重新签发使用新生效日，
 *    不追认历史班次；
 *  - 一个片区撤掉互认不影响当地已确立的原资格（已发证照不因此暂停）。
 */
import { assessRequirements, scoreState, usability } from './evidence.js';
import { versionAt } from './policy.js';
import { iso, ms } from './time.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { assertRegion, assertType } from './access.js';

/** 某条证据在 region 从 t 起还能被采信到何时（外区受互认截止约束，本地只受成绩有效期约束）。 */
function evidenceUsableUntil(store, region, score, t) {
  const centre = store.find('centres', score.centre);
  let until = ms(score.until);
  if (centre && centre.region !== region) {
    const version = versionAt(store, region, t);
    const entry = version.accepts.find(
      (item) => item.issuer === score.centre && item.subject === score.subject,
    );
    if (entry) until = Math.min(until, ms(entry.until));
  }
  return until;
}

/**
 * 建立/更新一份发证材料。逐科给出状态；材料完整才可签发。
 */
export function applyCase(store, actor, input) {
  assertType(actor, 'issuer');
  assertRegion(actor, input.region);
  for (const field of ['region', 'role', 'worker']) {
    if (!input[field]) throw new ValidationError(`缺少字段: ${field}`);
  }
  const t = iso(input.at ?? new Date());
  const assessment = assessRequirements(store, {
    region: input.region,
    role: input.role,
    worker: input.worker,
    t,
    scoreIds: input.scoreIds ?? null,
  });
  const rejected = assessment.subjects.some(
    (subject) => subject.status === 'missing'
      && ['SCORE_REVOKED', 'SCORE_OVERTURNED'].includes(subject.reason),
  );
  const status = rejected ? 'rejected' : assessment.status === 'complete' ? 'complete' : 'incomplete';
  const row = {
    id: input.id ?? store.nextId('case'),
    region: input.region,
    role: input.role,
    worker: input.worker,
    at: t,
    status,
    decision: null,
    ruleVersion: versionAt(store, input.region, t).id,
    subjects: assessment.subjects,
    problems: assessment.problems,
    certificate: null,
    decidedAt: null,
  };
  store.add('certCases', row);
  store.audit(actor.id, 'cert-case.apply', row.id, { status, worker: row.worker });
  return row;
}

/**
 * 签发。只接受材料完整的案件；签发区间为左闭右开 [from, until)。
 * until 取所有依据「可被采信终点」的最早值，缺省 from 为当前时点。
 */
export function issue(store, actor, caseId, input = {}) {
  const certCase = store.find('certCases', caseId);
  if (!certCase) throw new NotFoundError(`发证材料不存在: ${caseId}`);
  assertType(actor, 'issuer');
  assertRegion(actor, certCase.region);
  if (certCase.status === 'issued') throw new ConflictError('该材料已签发');
  if (certCase.status === 'rejected') throw new ConflictError('拒签材料不能签发，需重新申报');
  if (certCase.status !== 'complete') {
    throw new ConflictError('材料未完整，只能暂缓处理', { subjects: certCase.subjects });
  }
  const from = iso(input.from ?? certCase.at ?? new Date());
  // 签发当下重新核查，防止申请后规则/证据发生变化
  const reassessment = assessRequirements(store, {
    region: certCase.region,
    role: certCase.role,
    worker: certCase.worker,
    t: from,
  });
  if (reassessment.status !== 'complete') {
    certCase.status = 'incomplete';
    certCase.subjects = reassessment.subjects;
    certCase.problems = reassessment.problems;
    throw new ConflictError('签发复核时材料已不再完整，案件转回暂缓', { subjects: reassessment.subjects });
  }
  const scope = reassessment.subjects.map((subject) => subject.chosen);
  let until = Infinity;
  for (const scoreId of scope) {
    const score = store.find('scores', scoreId);
    until = Math.min(until, evidenceUsableUntil(store, certCase.region, score, from));
  }
  if (!Number.isFinite(until)) throw new ValidationError('无法计算证照有效期');
  const certificate = {
    id: input.id ?? store.nextId('cert'),
    worker: certCase.worker,
    region: certCase.region,
    role: certCase.role,
    scope,
    from,
    until: iso(until),
    status: 'issued',
    ruleVersion: versionAt(store, certCase.region, from).id,
    issuedCase: certCase.id,
    reissueOf: null,
  };
  store.add('certificates', certificate);
  certCase.status = 'issued';
  certCase.decision = 'issued';
  certCase.certificate = certificate.id;
  certCase.decidedAt = iso(new Date());
  store.add('certEvents', {
    id: store.nextId('cev'),
    certificate: certificate.id,
    at: iso(new Date()),
    type: 'issued',
    detail: { scope: [...scope], from, until: certificate.until, ruleVersion: certificate.ruleVersion },
  });
  store.audit(actor.id, 'cert.issue', certificate.id, { case: certCase.id, scope });
  return certificate;
}

/** 发证方暂缓：记录待补科目，不产生证照。 */
export function holdCase(store, actor, caseId, note, at = new Date()) {
  const certCase = store.find('certCases', caseId);
  if (!certCase) throw new NotFoundError(`发证材料不存在: ${caseId}`);
  assertRegion(actor, certCase.region);
  if (['issued', 'rejected', 'closed'].includes(certCase.status)) {
    throw new ConflictError(`当前状态 ${certCase.status} 不能暂缓`);
  }
  certCase.status = 'incomplete';
  certCase.decision = 'held';
  certCase.decidedAt = iso(at);
  certCase.holdNote = note ?? null;
  store.audit(actor.id, 'cert-case.hold', caseId, { note });
  return certCase;
}

/** 拒签：硬冲突材料结案，留档。 */
export function rejectCase(store, actor, caseId, reason, at = new Date()) {
  const certCase = store.find('certCases', caseId);
  if (!certCase) throw new NotFoundError(`发证材料不存在: ${caseId}`);
  assertRegion(actor, certCase.region);
  certCase.status = 'rejected';
  certCase.decision = 'rejected';
  certCase.decidedAt = iso(at);
  certCase.rejectReason = reason ?? null;
  store.audit(actor.id, 'cert-case.reject', caseId, { reason });
  return certCase;
}

function certificatesDependingOn(store, scoreId) {
  return store
    .list('certificates')
    .filter((certificate) => certificate.scope.includes(scoreId));
}

/**
 * 依据失效处理：只有依赖该成绩的证照进入暂停核验。
 * 已确认不成立、已过期的证照不再重复处理。
 */
export function suspendDependents(store, scoreId, cause, at = new Date()) {
  const suspended = [];
  for (const certificate of certificatesDependingOn(store, scoreId)) {
    if (certificate.status !== 'issued') continue;
    certificate.status = 'suspended';
    certificate.suspendedAt = iso(at);
    certificate.suspension = { score: scoreId, cause, at: iso(at) };
    store.add('certEvents', {
      id: store.nextId('cev'),
      certificate: certificate.id,
      at: iso(at),
      type: 'suspended',
      detail: { score: scoreId, cause },
    });
    store.audit('system', 'cert.suspend', certificate.id, { score: scoreId, cause });
    suspended.push(certificate);
  }
  return suspended;
}

/**
 * 用新成绩替代失效依据并重新核查当次签发条款。
 * 不满足当前（或指定评估时点）规则则继续暂停，不做无条件拼接；
 * 满足则恢复，有效期按替代后的证据重新计算，区间只向前不追认。
 */
export function replaceEvidence(store, actor, input, at = new Date()) {
  const certificate = store.find('certificates', input.certificate);
  if (!certificate) throw new NotFoundError(`证照不存在: ${input.certificate}`);
  assertType(actor, 'issuer');
  assertRegion(actor, certificate.region);
  if (certificate.status === 'invalid') throw new ConflictError('不成立证照不能替换依据，需重新签发');
  const newScore = store.find('scores', input.newScore);
  if (!newScore) throw new NotFoundError(`新成绩不存在: ${input.newScore}`);
  const replacedScore = input.replacedScore ?? certificate.suspension?.score;
  if (!replacedScore) throw new ValidationError('需指明被替代的失效成绩');

  const evaluateAt = iso(at);
  // 当次签发条款：按替代发生时的施行规则逐科重核，全部科目都要有可采信依据
  const reassessment = assessRequirements(store, {
    region: certificate.region,
    role: certificate.role,
    worker: certificate.worker,
    t: evaluateAt,
  });
  const newScoreCheck = usability(store, certificate.region, certificate.role, newScore, evaluateAt);
  const sameSubject = store.find('scores', replacedScore)?.subject === newScore.subject;
  if (!sameSubject || !newScoreCheck.usable || reassessment.status !== 'complete') {
    store.add('certEvents', {
      id: store.nextId('cev'),
      certificate: certificate.id,
      at: evaluateAt,
      type: 'replacement-rejected',
      detail: { newScore: newScore.id, reassessment: reassessment.subjects },
    });
    store.audit(actor.id, 'cert.replace-rejected', certificate.id, { newScore: newScore.id });
    return { restored: false, certificate, reassessment };
  }
  const scope = certificate.scope.filter((scoreId) => scoreId !== replacedScore);
  if (!scope.includes(newScore.id)) scope.push(newScore.id);
  let until = Infinity;
  for (const scoreId of scope) {
    const score = store.find('scores', scoreId);
    until = Math.min(until, evidenceUsableUntil(store, certificate.region, score, evaluateAt));
  }
  certificate.scope = scope;
  certificate.status = 'issued';
  certificate.from = evaluateAt; // 只向前生效，不追认暂停期间
  certificate.until = iso(until);
  certificate.ruleVersion = versionAt(store, certificate.region, evaluateAt).id;
  certificate.suspension = null;
  certificate.suspendedAt = null;
  store.add('certEvents', {
    id: store.nextId('cev'),
    certificate: certificate.id,
    at: evaluateAt,
    type: 'replaced-evidence',
    detail: { replacedScore, newScore: newScore.id, scope: [...scope], until: certificate.until },
  });
  store.audit(actor.id, 'cert.replace', certificate.id, { replacedScore, newScore: newScore.id });
  return { restored: true, certificate, reassessment };
}

/**
 * 确认证照不成立：留档不删除，授权方仍可核查；关联案件结案。
 */
export function invalidate(store, actor, certificateId, reason, at = new Date()) {
  const certificate = store.find('certificates', certificateId);
  if (!certificate) throw new NotFoundError(`证照不存在: ${certificateId}`);
  assertType(actor, 'issuer', 'regulator');
  certificate.status = 'invalid';
  certificate.invalidatedAt = iso(at);
  certificate.invalidReason = reason ?? null;
  store.add('certEvents', {
    id: store.nextId('cev'),
    certificate: certificate.id,
    at: iso(at),
    type: 'invalidated',
    detail: { reason },
  });
  for (const certCase of store.list('certCases').filter((item) => item.certificate === certificateId)) {
    certCase.status = 'closed';
    certCase.decision = 'invalidated';
    certCase.decidedAt = iso(at);
  }
  store.audit(actor.id, 'cert.invalidate', certificateId, { reason });
  return certificate;
}

/**
 * 重新签发：必须基于新材料重新走完整核查，生成新证照与新生效日，
 * 与旧证照编号不同、互不追认。
 */
export function reissue(store, actor, input) {
  const old = store.find('certificates', input.certificate);
  if (!old) throw new NotFoundError(`证照不存在: ${input.certificate}`);
  if (old.status !== 'invalid') throw new ConflictError('只有确认不成立的证照需要重新签发');
  const certCase = applyCase(store, actor, {
    region: old.region,
    role: old.role,
    worker: old.worker,
    at: input.at,
    scoreIds: input.scoreIds,
  });
  if (certCase.status !== 'complete') {
    return { certificate: null, certCase, message: '新材料仍不完整，案件暂缓' };
  }
  const certificate = issue(store, actor, certCase.id, { from: input.from ?? input.at });
  certificate.reissueOf = old.id;
  store.add('certEvents', {
    id: store.nextId('cev'),
    certificate: certificate.id,
    at: iso(new Date()),
    type: 'reissued',
    detail: { reissueOf: old.id },
  });
  store.audit(actor.id, 'cert.reissue', certificate.id, { origin: old.id });
  return { certificate, certCase };
}

/** 监管/发证留档查询：含已不成立证照的完整事件链。 */
export function certificateFile(store, actor, certificateId) {
  assertType(actor, 'issuer', 'regulator');
  const certificate = store.find('certificates', certificateId);
  if (!certificate) throw new NotFoundError(`证照不存在: ${certificateId}`);
  return {
    certificate,
    events: store.list('certEvents').filter((event) => event.certificate === certificateId),
    scoreTrail: certificate.scope.map((scoreId) => {
      const score = store.find('scores', scoreId);
      return {
        score,
        state: score ? scoreState(store, score, new Date()) : null,
        revisions: store.list('scoreRevisions').filter((revision) => revision.score === scoreId),
      };
    }),
  };
}
