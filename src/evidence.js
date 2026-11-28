/**
 * 成绩证据。
 *
 * 原考点出分（scores）与复核结果（scoreRevisions）各自留档：
 * 复核通过追加一条 passed=true 的修订；复核推翻单科则追加 passed=false。
 * 成绩的「当前结论」取时间上最后一条记录，但原文永不删除。
 *
 * 一条成绩在某片区、某时点可作为依据，必须同时满足：
 *   - worker / role / subject 与目标一致；
 *   - 当前结论为通过（未被复核推翻、未撤销）；
 *   - 成绩自身有效期未过；
 *   - 本片区成绩：考点归属本片区；
 *   - 外区成绩：互认在该时点仍有效（来源考点、科目、互认截止、政策通告）。
 */
import { acceptanceStatus, requirementsAt } from './policy.js';
import { iso, ms } from './time.js';
import { NotFoundError, PermissionError, ValidationError } from './errors.js';

/** 取该成绩截至 t 的最后一条复核（含撤销）。同时点按插入顺序确定先后。 */
export function latestRevision(store, scoreId, t = new Date()) {
  const at = ms(t);
  let picked = null;
  for (const revision of store.list('scoreRevisions')) {
    if (revision.score === scoreId && ms(revision.at) <= at) {
      if (picked === null
        || ms(revision.at) > ms(picked.at)
        || (ms(revision.at) === ms(picked.at) && (revision.order ?? 0) > (picked.order ?? 0))) {
        picked = revision;
      }
    }
  }
  return picked;
}

/** 截至 t 时该成绩的结论与依据链。 */
export function scoreState(store, score, t = new Date()) {
  const revision = latestRevision(store, score.id, t);
  const passedAtT = revision ? revision.passed : score.passed;
  const revoked = revision?.revoked === true;
  return {
    score,
    revision,
    passed: passedAtT && !revoked,
    revoked,
    validUntilOwn: ms(t) < ms(score.until),
  };
}

/**
 * 判定一条成绩能否在 region 的 t 时点充当 role 工种的科目证据。
 * 返回 { usable:true, score } 或 { usable:false, reason, message, ... }。
 */
export function usability(store, region, role, score, t) {
  if (score.role !== role) {
    return { usable: false, reason: 'ROLE_MISMATCH', message: '成绩工种与申报工种不一致' };
  }
  const centre = store.find('centres', score.centre);
  if (!centre) return { usable: false, reason: 'UNKNOWN_CENTRE', message: '来源考点不存在' };

  const state = scoreState(store, score, t);
  if (state.revoked) {
    return { usable: false, reason: 'SCORE_REVOKED', message: '外区（或原考点）已撤销该成绩', revision: state.revision?.id };
  }
  if (!state.passed) {
    return { usable: false, reason: 'SCORE_OVERTURNED', message: '复核推翻了该单科通过', revision: state.revision?.id };
  }
  if (!state.validUntilOwn) {
    return { usable: false, reason: 'SCORE_EXPIRED', message: '成绩有效期已过', until: score.until };
  }

  if (centre.region === region) {
    return { usable: true, score, kind: 'local' };
  }
  const acceptance = acceptanceStatus(store, region, score.centre, score.subject, t);
  if (!acceptance.allowed) {
    return {
      usable: false,
      reason: acceptance.reason,
      message: acceptance.message,
      kind: 'external',
      ...(acceptance.until ? { until: acceptance.until } : {}),
      ...(acceptance.notice ? { notice: acceptance.notice } : {}),
    };
  }
  return { usable: true, score, kind: 'external' };
}

/**
 * 评估某 worker 在某片区某工种、某时点持有的全部可用证据，按科目归类。
 * 同一科目多条可用时保留有效期最早截止的一条用于保守计算，其余一并返回。
 */
export function evaluateEvidence(store, { region, role, worker, t, scoreIds = null }) {
  const candidates = store
    .list('scores')
    .filter((score) => score.worker === worker && score.role === role && score.subject);
  const scoped = scoreIds ? candidates.filter((score) => scoreIds.includes(score.id)) : candidates;
  const bySubject = new Map();
  const problems = [];
  for (const score of scoped) {
    const result = usability(store, region, role, score, t);
    if (result.usable) {
      const list = bySubject.get(score.subject) ?? [];
      list.push(result);
      bySubject.set(score.subject, list);
    } else {
      problems.push({ score: score.id, subject: score.subject, ...result });
    }
  }
  const usable = {};
  for (const [subject, list] of bySubject) {
    list.sort((a, b) => ms(a.score.until) - ms(b.score.until));
    usable[subject] = list;
  }
  return { usable, problems };
}

/**
 * 按目标片区 t 时点的科目组合逐科评估。
 * 返回每个要求科目的状态，以及整体结论 complete / incomplete / rejected。
 *  - complete：每一科都有可用证据；
 *  - incomplete：存在缺失或暂时不可用（缺科、待补考、政策暂缓等）；
 *  - rejected：出现不可通过补同一科目挽回的硬冲突（工种不符除外，此处仅保留分类位）。
 */
export function assessRequirements(store, { region, role, worker, t, scoreIds = null }) {
  const required = requirementsAt(store, region, role, t);
  const { usable, problems } = evaluateEvidence(store, { region, role, worker, t, scoreIds });
  const subjects = required.map((subject) => {
    const options = usable[subject] ?? [];
    const subjectProblems = problems.filter((problem) => problem.subject === subject);
    if (options.length) {
      return { subject, status: 'covered', chosen: options[0].score.id, alternatives: options.map((item) => item.score.id), kind: options[0].kind };
    }
    const blocking = subjectProblems.find((problem) =>
      ['SCORE_REVOKED', 'SCORE_OVERTURNED', 'RECIPROCITY_STOPPED', 'NOT_IN_SCOPE', 'ACCEPTANCE_EXPIRED'].includes(problem.reason),
    );
    return {
      subject,
      status: 'missing',
      reason: blocking?.reason ?? 'NO_EVIDENCE',
      message: blocking?.message ?? '尚无该科目成绩',
      blockingEvidence: subjectProblems.map((problem) => problem.score),
    };
  });
  const missing = subjects.filter((item) => item.status === 'missing');
  const status = missing.length === 0 ? 'complete' : 'incomplete';
  return { status, required, subjects, problems };
}

/**
 * 合作考点分次送分：同一 worker+role+subject+centre 允许后续再送，
 * 每次都是独立原文记录，缺科判定由 assessRequirements 统一处理。
 */
export function receiveScore(store, actor, input) {
  const centre = store.find('centres', actor.centreId);
  if (!centre) throw new PermissionError('该操作者不属于任何考点');
  const required = ['worker', 'role', 'subject', 'passed', 'until'];
  for (const field of required) {
    if (input[field] === undefined || input[field] === null) {
      throw new ValidationError(`送分缺少字段: ${field}`);
    }
  }
  if (typeof input.passed !== 'boolean') throw new ValidationError('passed 必须为布尔值');
  const row = {
    id: input.id ?? store.nextId('score'),
    worker: input.worker,
    centre: centre.id,
    role: input.role,
    subject: input.subject,
    passed: input.passed,
    until: iso(input.until),
    receivedAt: iso(input.at ?? new Date()),
    batch: input.batch ?? null,
  };
  if (store.find('scores', row.id)) throw new ValidationError(`成绩编号已存在: ${row.id}`);
  store.add('scores', row);
  store.audit(actor.id, 'score.receive', row.id, {
    worker: row.worker,
    subject: row.subject,
    passed: row.passed,
    batch: row.batch,
  });
  return row;
}

/**
 * 复核员提出复核（含撤销）。只有具备 reviewer 权限的角色可调用，
 * 原成绩保留，复核结果单独留档并带时间，后续所有判定以截至时点的最后一条为准。
 */
export function reviseScore(store, actor, input) {
  if (actor?.type !== 'reviewer') {
    throw new PermissionError('事后改成绩只能由有权的复核员提出');
  }
  const score = store.find('scores', input.score);
  if (!score) throw new NotFoundError(`成绩不存在: ${input.score}`);
  if (typeof input.passed !== 'boolean') throw new ValidationError('passed 必须为布尔值');
  const row = {
    id: input.id ?? store.nextId('rev'),
    order: store.nextOrder(),
    score: score.id,
    at: iso(input.at ?? new Date()),
    passed: input.passed,
    revoked: input.revoked === true,
    reason: input.reason ?? null,
    by: actor.id,
  };
  store.add('scoreRevisions', row);
  store.audit(actor.id, row.revoked ? 'score.revoke' : 'score.revise', score.id, {
    revision: row.id,
    passed: row.passed,
    revoked: row.revoked,
    reason: row.reason,
  });
  return row;
}
