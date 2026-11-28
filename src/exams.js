/**
 * 补考考务。
 *
 * 报考单 examClaim 状态机：
 *   reserved（已预留席位）/ waitlisted（候补）/ checked-in（已签到）
 *   / absent（未签到）/ denied（签到时被规则拒绝，席位释放）
 *   / cancelled（主动取消，席位释放）
 *
 * 关键规则：
 *  - 允许先预留席位；能否签到以补考当天规则与互认证据为准，预约不等于可续证；
 *  - 考试下发时锁定科目与人员，之后不再接受新报考；
 *  - 已签到的科目不因他人补报而被挪用；席位空出时候补重新判定；
 *  - 考点只能维护自己的考场，只能给具备出席资格（已签到）的人录成绩；
 *  - 事后改成绩只能走 evidence.reviseScore 复核通道，本模块不提供修改入口。
 */
import { assessRequirements } from './evidence.js';
import { diffVersions } from './policy.js';
import { iso, ms } from './time.js';
import { ConflictError, NotFoundError, PermissionError, ValidationError } from './errors.js';
import { assertCentreOwnership, assertType } from './access.js';

const SEAT_TAKEN = new Set(['reserved', 'checked-in']);
const ACTIVE_CLAIM = new Set(['reserved', 'waitlisted', 'checked-in']);

export function createExam(store, actor, input) {
  assertType(actor, 'centre-operator');
  const centre = store.find('centres', actor.centreId);
  if (!centre) throw new PermissionError('操作者不属于有效考点');
  for (const field of ['role', 'subject', 'from', 'seats']) {
    if (input[field] === undefined || input[field] === null) {
      throw new ValidationError(`考场缺少字段: ${field}`);
    }
  }
  if (!Number.isInteger(input.seats) || input.seats <= 0) {
    throw new ValidationError('seats 必须为正整数');
  }
  const exam = {
    id: input.id ?? store.nextId('exam'),
    centre: centre.id,
    role: input.role,
    subject: input.subject,
    from: iso(input.from),
    seats: input.seats,
    locked: false,
    lockedAt: null,
    lockedSubjects: null,
    lockedWorkers: null,
  };
  store.add('exams', exam);
  store.audit(actor.id, 'exam.create', exam.id, { subject: exam.subject, seats: exam.seats });
  return exam;
}

function claimsOf(store, examId) {
  return store
    .list('examClaims')
    .filter((claim) => claim.exam === examId)
    .sort((a, b) => ms(a.at) - ms(b.at));
}

function takenSeats(store, examId) {
  return claimsOf(store, examId).filter((claim) => SEAT_TAKEN.has(claim.status)).length;
}

/**
 * 报考（预留席位或进入候补）。同一工人对同一场次只允许一条有效报考。
 * citations 为报考人引用的旧成绩编号，可跨区；不传则仅提示缺什么。
 */
export function reserveSeat(store, actor, input) {
  const exam = store.find('exams', input.exam);
  if (!exam) throw new NotFoundError(`考场不存在: ${input.exam}`);
  if (!input.worker) throw new ValidationError('worker 必填');
  if (exam.locked) throw new ConflictError('考试已下发锁定，不再接受报考');
  const duplicate = claimsOf(store, exam.id).find(
    (claim) => claim.worker === input.worker && ACTIVE_CLAIM.has(claim.status),
  );
  if (duplicate) throw new ConflictError('该工人已报考本场次', { claim: duplicate.id });

  const at = iso(input.at ?? new Date());
  const status = takenSeats(store, exam.id) < exam.seats ? 'reserved' : 'waitlisted';
  const claim = {
    id: input.id ?? store.nextId('claim'),
    exam: exam.id,
    worker: input.worker,
    at,
    citations: Array.isArray(input.citations) ? [...input.citations] : [],
    status,
    decidedAt: null,
    notice: null,
  };
  store.add('examClaims', claim);
  store.audit(actor?.id ?? 'self', 'exam.reserve', claim.id, {
    exam: exam.id,
    worker: claim.worker,
    status,
  });
  return { claim, eligibility: checkEligibility(store, exam, claim, at) };
}

/**
 * 报名后规则变化检查：比较报名时点与检查时点的规则版本，
 * 结合当前逐科证据给出「还需要补什么」。
 */
export function checkEligibility(store, exam, claim, t = new Date()) {
  const centre = store.find('centres', exam.centre);
  const region = centre.region;
  const assessment = assessRequirements(store, {
    region,
    role: exam.role,
    worker: claim.worker,
    t,
    scoreIds: (claim.citations?.length ?? 0) ? claim.citations : null,
  });
  const subject = assessment.subjects.find((item) => item.subject === exam.subject);
  const ruleChange = diffVersions(store, region, claim.at, t);
  const changed = ruleChange.roleChanges.some((item) => item.role === exam.role)
    || (ruleChange.acceptanceChanges?.length ?? 0) > 0;
  const notices = [];
  if (changed) {
    notices.push({
      type: 'RULE_CHANGED_AFTER_CLAIM',
      message: '报名后规则已变化，请按当前施行规则补齐材料',
      diff: ruleChange,
    });
  }
  const subjectEligible = subject?.status === 'covered';
  if (!subjectEligible) {
    notices.push({
      type: 'SUBJECT_NOT_QUALIFIED',
      subject: exam.subject,
      reason: subject?.reason ?? 'NO_EVIDENCE',
      message: subject?.message ?? '该科目尚无可被当地接受的有效成绩',
    });
  }
  return {
    eligibleAt: iso(t),
    subjectEligible,
    required: assessment.required,
    subject,
    notices,
    ruleVersion: ruleChange.toVersion,
  };
}

/**
 * 考试下发：锁定科目与人员。锁定时刻仍占座的报考单（含候补名单顺序）被冻结，
 * 之后新报考一律拒绝；候补在锁定后仍可因席位空出而递补。
 */
export function lockExam(store, actor, examId, at = new Date()) {
  const exam = store.find('exams', examId);
  if (!exam) throw new NotFoundError(`考场不存在: ${examId}`);
  assertCentreOwnership(actor, exam, store);
  if (exam.locked) throw new ConflictError('考场已锁定');
  exam.locked = true;
  exam.lockedAt = iso(at);
  exam.lockedSubjects = [exam.subject];
  exam.lockedWorkers = claimsOf(store, examId)
    .filter((claim) => ACTIVE_CLAIM.has(claim.status))
    .map((claim) => claim.worker);
  store.audit(actor.id, 'exam.lock', exam.id, { workers: exam.lockedWorkers });
  return exam;
}

/**
 * 候补重新判定：按报考顺序把可用空座依次分给仍具资格的候补者。
 * 已签到者永远不会被挤掉（其状态不参与空座计算之外的变更）。
 */
export function rejudgeWaitlist(store, examId, t = new Date()) {
  const exam = store.find('exams', examId);
  if (!exam) throw new NotFoundError(`考场不存在: ${examId}`);
  const promoted = [];
  for (const claim of claimsOf(store, examId)) {
    if (claim.status !== 'waitlisted') continue;
    if (takenSeats(store, examId) >= exam.seats) break;
    const eligibility = checkEligibility(store, exam, claim, t);
    // 候补资格要重新判：资格不成立就继续保留候补，不占座也不踢人
    if (eligibility.subjectEligible) {
      claim.status = 'reserved';
      claim.decidedAt = iso(t);
      claim.notice = { type: 'WAITLIST_PROMOTED', at: iso(t) };
      promoted.push(claim);
    }
  }
  return promoted;
}

/**
 * 补考当天签到。是否能签到只看当天规则与互认证据，与预约时的判断相互独立。
 * 签到被拒释放席位，随后立即重判候补。
 */
export function checkIn(store, actor, input) {
  const exam = store.find('exams', input.exam);
  if (!exam) throw new NotFoundError(`考场不存在: ${input.exam}`);
  assertCentreOwnership(actor, exam, store);
  if (!exam.locked) throw new ConflictError('考试尚未下发锁定，不能签到');
  const claim = claimsOf(store, exam.id).find(
    (item) => item.worker === input.worker && ACTIVE_CLAIM.has(item.status),
  );
  if (!claim) throw new NotFoundError('该工人不在本场次锁定名单中');
  if (claim.status === 'checked-in') throw new ConflictError('该工人已签到');
  const t = iso(input.at ?? new Date());

  const eligibility = checkEligibility(store, exam, claim, t);
  claim.eligibilityAtCheckIn = eligibility;
  if (!eligibility.subjectEligible) {
    if (claim.status === 'reserved') {
      claim.status = 'denied';
      claim.decidedAt = t;
      store.audit(actor.id, 'exam.deny-checkin', claim.id, { notices: eligibility.notices });
      const promoted = rejudgeWaitlist(store, exam.id, t);
      return { claim, admitted: false, eligibility, promoted };
    }
    // 候补资格不成立：留在候补
    claim.notice = { type: 'WAITLIST_NOT_ELIGIBLE', at: t, notices: eligibility.notices };
    return { claim, admitted: false, eligibility, promoted: [] };
  }
  if (claim.status === 'waitlisted') {
    if (takenSeats(store, exam.id) >= exam.seats) {
      claim.notice = { type: 'WAITLIST_NO_SEAT', at: t };
      return { claim, admitted: false, eligibility, promoted: [] };
    }
  }
  claim.status = 'checked-in';
  claim.decidedAt = t;
  claim.checkedInAt = t;
  store.audit(actor.id, 'exam.check-in', claim.id, { worker: claim.worker });
  return { claim, admitted: true, eligibility, promoted: [] };
}

/** 报考人主动取消或考点标记缺考，均释放席位并重判候补。 */
export function cancelClaim(store, actor, claimId, at = new Date()) {
  const claim = store.find('examClaims', claimId);
  if (!claim) throw new NotFoundError(`报考单不存在: ${claimId}`);
  if (claim.status === 'checked-in') {
    throw new ConflictError('已签到的报考单不能取消，需按缺考/复核流程处理');
  }
  const exam = store.find('exams', claim.exam);
  const wasHolding = claim.status === 'reserved';
  claim.status = 'cancelled';
  claim.decidedAt = iso(at);
  store.audit(actor?.id ?? 'self', 'exam.cancel', claim.id);
  const promoted = wasHolding ? rejudgeWaitlist(store, exam.id, at) : [];
  return { claim, promoted };
}

/**
 * 录入当场成绩：考试必须已锁定，工人必须已签到，科目必须是锁定科目。
 * 考点只能操作自己的考场。
 */
export function enterScore(store, actor, input) {
  const exam = store.find('exams', input.exam);
  if (!exam) throw new NotFoundError(`考场不存在: ${input.exam}`);
  assertCentreOwnership(actor, exam, store);
  if (!exam.locked) throw new ConflictError('考试未锁定，不能录入成绩');
  const claim = claimsOf(store, exam.id).find((item) => item.worker === input.worker);
  if (!claim || claim.status !== 'checked-in') {
    throw new PermissionError('只能为已签到、具备出席资格的人员录入成绩');
  }
  const row = {
    id: input.id ?? store.nextId('score'),
    worker: input.worker,
    centre: exam.centre,
    role: exam.role,
    subject: exam.subject,
    passed: Boolean(input.passed),
    until: iso(input.until),
    receivedAt: iso(input.at ?? new Date()),
    exam: exam.id,
  };
  store.add('scores', row);
  store.audit(actor.id, 'score.enter', row.id, {
    exam: exam.id,
    worker: row.worker,
    passed: row.passed,
  });
  return row;
}
