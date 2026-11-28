/**
 * 班组班次资格证明。
 *
 * proofLetter 状态（班组视角）：
 *   confirmed（整段有可用对应资格）/ denied（存在缺证，逐段给出原因类别）
 *
 * 证据推翻后的处理按班次时点区分：
 *   - 班次开始前：更新班组可见状态，证明翻转为 denied/缺口，提示补人；
 *   - 班次进行中：原结论不改写，附加 alert，提示主管立即复核；
 *   - 班次已结束：只追加事后获知影响（post-hoc impact），
 *     不把当时发给班组的结果改成「从未确认」。
 *
 * 承包商视图仅包含排程信息、缺口时间段与原因类别，不含分数、证照编号等敏感字段。
 */
import { gapsOf, iso, mergeCover, ms } from './time.js';
import { NotFoundError, PermissionError, ValidationError } from './errors.js';
import { assertContractor, assertType } from './access.js';

/** 原因类别（对承包商可见的最小信息集）。 */
export const GAP_REASONS = {
  NO_CERTIFICATE: 'NO_CERTIFICATE', // 没有对应片区/工种的有效证照
  CERTIFICATE_EXPIRED: 'CERTIFICATE_EXPIRED', // 旧证到期、新证未接续
  CERTIFICATE_SUSPENDED: 'CERTIFICATE_SUSPENDED', // 依据失效，暂停核验
  CERTIFICATE_INVALID: 'CERTIFICATE_INVALID', // 证照确认不成立
  MISSING_SUBJECT: 'MISSING_SUBJECT', // 科目组合不完整
};

function activeCertificateIntervals(store, shift, worker, t) {
  // 暂停核验的证照仍占据其名义区间，是否可上岗由缺口原因类别表达；
  // 只有确认不成立（invalid）的证照完全不产生覆盖。
  return store
    .list('certificates')
    .filter(
      (certificate) =>
        certificate.worker === worker
        && certificate.region === shift.region
        && certificate.role === shift.role
        && (certificate.status === 'issued' || certificate.status === 'suspended'),
    )
    .map((certificate) => ({ from: certificate.from, until: certificate.until, certificate }));
}

function classifyGap(store, shift, worker, gapStart) {
  // 分类要查看全部证照（含暂停、不成立），覆盖计算才只计 issued。
  const certificates = store
    .list('certificates')
    .filter(
      (certificate) =>
        certificate.worker === worker
        && certificate.region === shift.region
        && certificate.role === shift.role,
    );
  if (!certificates.length) return GAP_REASONS.NO_CERTIFICATE;
  const covering = certificates.find(
    (certificate) => ms(certificate.from) <= ms(gapStart) && ms(gapStart) < ms(certificate.until),
  );
  if (covering) {
    if (covering.status === 'suspended') return GAP_REASONS.CERTIFICATE_SUSPENDED;
    if (covering.status === 'invalid') return GAP_REASONS.CERTIFICATE_INVALID;
  }
  const expired = certificates
    .filter((certificate) => ms(certificate.until) <= ms(gapStart))
    .sort((a, b) => ms(b.until) - ms(a.until))[0];
  if (expired) {
    if (expired.status === 'suspended') return GAP_REASONS.CERTIFICATE_SUSPENDED;
    if (expired.status === 'invalid') return GAP_REASONS.CERTIFICATE_INVALID;
    return GAP_REASONS.CERTIFICATE_EXPIRED;
  }
  return GAP_REASONS.MISSING_SUBJECT;
}

/**
 * 评估某工人对某班次的整段覆盖。
 * 多个证照区间无缝接续可共同覆盖；任何小段无法覆盖都逐段列出。
 * suspended 证照保留名义区间（缺口原因标 CERTIFICATE_SUSPENDED），
 * 但不能让证明变成 confirmed。
 */
export function evaluateShift(store, shiftId, worker, t = new Date()) {
  const shift = store.find('shifts', shiftId);
  if (!shift) throw new NotFoundError(`班次不存在: ${shiftId}`);
  const window = { from: shift.from, until: shift.until };
  const intervals = activeCertificateIntervals(store, shift, worker, t);
  const covered = mergeCover(intervals, window);
  const gaps = gapsOf(window, covered).map((gap) => ({
    ...gap,
    reason: classifyGap(store, shift, worker, gap.from),
  }));
  // 暂停段：名义区间内由 suspended 证照覆盖的部分，逐段补进缺口列表
  const issuedIntervals = intervals
    .filter((item) => item.certificate.status === 'issued')
    .map((item) => ({ from: item.from, until: item.until }));
  const suspendedIntervals = intervals
    .filter((item) => item.certificate.status === 'suspended')
    .map((item) => ({ from: item.from, until: item.until }));
  const suspendedGaps = gapsOf(window, mergeCover(issuedIntervals, window))
    .filter((gap) => mergeCover(suspendedIntervals, gap).length > 0);
  // 纯缺口与暂停缺口可能相交/包含，先并成互不相交的区间再逐段分类
  const unionGaps = mergeCover([...gaps, ...suspendedGaps], window);
  const allGaps = unionGaps.map((gap) => ({
    ...gap,
    reason: classifyGap(store, shift, worker, gap.from),
  }));
  return {
    shift: shift.id,
    worker,
    region: shift.region,
    role: shift.role,
    window,
    covered,
    gaps: allGaps,
    confirmed: allGaps.length === 0,
  };
}

/**
 * 班组申请具体班次的资格证明。一个班次可分别为多名工人出具。
 */
export function requestProof(store, actor, input) {
  assertType(actor, 'contractor', 'issuer', 'regulator');
  const shift = store.find('shifts', input.shift);
  if (!shift) throw new NotFoundError(`班次不存在: ${input.shift}`);
  if (actor.type === 'contractor') assertContractor(actor, shift.contractor);
  if (!input.worker) throw new ValidationError('worker 必填');
  const t = iso(input.at ?? new Date());
  const evaluation = evaluateShift(store, shift.id, input.worker, t);
  const letter = {
    id: input.id ?? store.nextId('letter'),
    shift: shift.id,
    worker: input.worker,
    certificate: evaluation.covered[0]?.certificate?.id ?? null,
    recordedAt: t,
    status: evaluation.confirmed ? 'confirmed' : 'denied',
    coveredFrom: evaluation.covered[0]?.from ?? null,
    coveredUntil: evaluation.covered.length
      ? evaluation.covered.map((item) => item.until).sort().at(-1)
      : null,
    gaps: evaluation.gaps,
    impacts: [],
  };
  store.add('proofLetters', letter);
  store.audit(actor.id, 'proof.request', letter.id, { shift: shift.id, worker: input.worker, status: letter.status });
  return { letter, evaluation };
}

function reevaluate(store, letter) {
  const shift = store.find('shifts', letter.shift);
  const evaluation = evaluateShift(store, shift.id, letter.worker, new Date());
  return { shift, evaluation };
}

/**
 * 证据变化（复核推翻/撤销/暂停/恢复/不成立）后，重算所有受影响工人的证明。
 * 按证据变化时点相对班次的位置选择处理方式：
 *   before-start → 班组可见状态直接变化；
 *   in-progress  → 保留原结论，挂主管复核告警；
 *   after-end    → 仅追加事后影响，不改写历史结论。
 */
export function applyEvidenceEvent(store, input, at = new Date()) {
  const eventAt = ms(at);
  const affected = [];
  for (const letter of store.list('proofLetters')) {
    const shift = store.find('shifts', letter.shift);
    if (shift.from === undefined) continue;
    const workerMatches = input.workers?.includes(letter.worker) ?? true;
    if (!workerMatches) continue;
    const { evaluation } = reevaluate(store, letter);
    const impact = {
      id: store.nextId('impact'),
      at: iso(at),
      cause: input.cause,
      score: input.score ?? null,
      certificate: input.certificate ?? null,
      phase: eventAt < ms(shift.from) ? 'before-start'
        : eventAt < ms(shift.until) ? 'in-progress'
          : 'after-end',
      confirmedNow: evaluation.confirmed,
      gaps: evaluation.gaps,
      note: null,
    };
    if (impact.phase === 'before-start') {
      letter.status = evaluation.confirmed ? 'confirmed' : 'denied';
      letter.gaps = evaluation.gaps;
      impact.note = '班次开始前资格发生变化，班组应及时补人';
    } else if (impact.phase === 'in-progress') {
      letter.alert = {
        level: 'SUPERVISOR_REVIEW_REQUIRED',
        at: iso(at),
        cause: input.cause,
        message: '班次进行中发现历史证据问题，请主管立即复核',
      };
      impact.note = '当前班次提示主管立即复核，原证明结论保留';
    } else {
      impact.note = '班次已结束，仅记录事后获知影响，历史证明结论不改写';
    }
    letter.impacts.push(impact.id);
    store.add('letterImpacts', impact);
    store.audit('system', 'proof.impact', letter.id, { phase: impact.phase, cause: impact.cause });
    affected.push({ letter: letter.id, ...impact });
  }
  return affected;
}

/** 承包商视图：自己的班组怎么排、哪段缺证及原因类别；无分数、无他人资料。 */
export function contractorView(store, actor, shiftId = null) {
  assertType(actor, 'contractor');
  const shifts = store
    .list('shifts')
    .filter((shift) => shift.contractor === actor.contractorId && (!shiftId || shift.id === shiftId));
  if (shiftId && !shifts.length) throw new NotFoundError(`班次不存在: ${shiftId}`);
  return shifts.map((shift) => {
    const letters = store
      .list('proofLetters')
      .filter((letter) => letter.shift === shift.id);
    return {
      shift: shift.id,
      region: shift.region,
      role: shift.role,
      from: shift.from,
      until: shift.until,
      statuses: letters.map((letter) => ({
        worker: letter.worker,
        proofStatus: letter.status,
        gaps: letter.gaps.map((gap) => ({ from: gap.from, until: gap.until, reasonCategory: gap.reason })),
        alert: letter.alert ? { level: letter.alert.level, message: letter.alert.message } : null,
      })),
    };
  });
}
