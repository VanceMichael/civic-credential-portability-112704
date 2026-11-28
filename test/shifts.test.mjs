import assert from 'node:assert/strict';
import test from 'node:test';

import { CredentialService } from '../src/service.js';
import { GAP_REASONS } from '../src/shifts.js';

const DATA_URL = new URL('../data/records.json', import.meta.url);
const issuerRiver = { id: 'issuer-r', type: 'issuer', region: 'river-zone' };
const reviewer = { id: 'rev-1', type: 'reviewer' };
const centreR = { id: 'op-r', type: 'centre-operator', centreId: 'school-r' };
const contractorFen = { id: 'c-fen', type: 'contractor', contractorId: 'fen' };
const contractorSalt = { id: 'c-salt', type: 'contractor', contractorId: 'salt' };

async function setup() {
  const service = await CredentialService.fromFile(DATA_URL);
  service.defineActor(issuerRiver);
  service.defineActor(reviewer);
  service.defineActor(centreR);
  service.defineActor(contractorFen);
  service.defineActor(contractorSalt);
  return service;
}

function localCert(service, worker, from, until, subjectUntils) {
  const ids = [];
  for (const [subject, scoreUntil] of Object.entries(subjectUntils)) {
    const score = service.receiveScore(centreR, {
      worker, role: 'press', subject, passed: true,
      until: scoreUntil, at: from,
    });
    ids.push(score.id);
  }
  const certCase = service.applyCase(issuerRiver, {
    region: 'river-zone', role: 'press', worker, at: from,
  });
  return service.issue(issuerRiver, certCase.id, { from });
}

test('联调主线：夜班跨旧证到期，证明只覆盖到 16:00，缺口逐段给出原因类别', async () => {
  const service = await setup();
  // 资料中的历史证明 letter-r 名义覆盖 15:30–16:00；证照在 16:20 复核中被暂停，
  // 暂停证照保留名义区间，故整段 15:30–19:00 均为暂停核验缺口
  const letter = service.get('proofLetters', 'letter-r');
  assert.equal(letter.status, 'denied');
  assert.deepEqual(letter.gaps.map((gap) => gap.reason), [GAP_REASONS.CERTIFICATE_SUSPENDED]);
  const gap = letter.gaps[0];
  assert.equal(gap.from, '2027-02-01T15:30:00Z');
  assert.equal(gap.until, '2027-02-01T19:00:00Z');

  // 直接评估同一班次同一工人，结论一致
  const evaluation = service.evaluateShift('night-r', 'lark', '2027-01-30T08:00:00Z');
  assert.equal(evaluation.confirmed, false);
  assert.equal(evaluation.gaps[0].reason, GAP_REASONS.CERTIFICATE_SUSPENDED);
});

test('纯到期场景：无暂停的证照到期后缺口归类为 CERTIFICATE_EXPIRED', async () => {
  const service = await setup();
  localCert(service, 'expire-only', '2027-01-01T00:00:00Z', null, {
    theory: '2027-02-01T16:00:00Z',
    practice: '2027-02-01T16:00:00Z',
  });
  service.store.add('shifts', {
    id: 'shift-expire', region: 'river-zone', role: 'press', contractor: 'fen',
    from: '2027-02-01T15:30:00Z', until: '2027-02-01T19:00:00Z',
  });
  const { letter } = service.requestProof(issuerRiver, {
    shift: 'shift-expire', worker: 'expire-only', at: '2027-01-20T00:00:00Z',
  });
  assert.equal(letter.status, 'denied');
  assert.equal(letter.gaps[0].reason, GAP_REASONS.CERTIFICATE_EXPIRED);
  assert.deepEqual(
    { from: letter.gaps[0].from, until: letter.gaps[0].until },
    { from: '2027-02-01T16:00:00Z', until: '2027-02-01T19:00:00Z' },
  );
});

test('无缝接续：旧证到期与新证开始首尾相接可覆盖横跨午夜的整段班次', async () => {
  const service = await setup();
  // 两张证照：第一张 22:00–01:00，第二张 01:00–05:00（左闭右开，01:00 首尾相接）
  localCert(service, 'seam', '2027-04-01T22:00:00Z', null, {
    theory: '2027-05-01T01:00:00Z',
    practice: '2027-05-01T01:00:00Z',
  });
  localCert(service, 'seam', '2027-05-01T01:00:00Z', null, {
    theory: '2027-06-01T00:00:00Z',
    practice: '2027-06-01T00:00:00Z',
  });
  // 构造一个横跨午夜的班次
  service.store.add('shifts', {
    id: 'overnight', region: 'river-zone', role: 'press', contractor: 'fen',
    from: '2027-05-01T22:00:00Z', until: '2027-05-02T04:00:00Z',
  });
  const result = service.requestProof(issuerRiver, {
    shift: 'overnight', worker: 'seam', at: '2027-04-20T00:00:00Z',
  });
  assert.equal(result.letter.status, 'confirmed');
  assert.deepEqual(result.evaluation.gaps, []);
});

test('哪怕中间只有一小段无法覆盖，也要指出具体不能上岗的时间', async () => {
  const service = await setup();
  localCert(service, 'tiny-gap', '2027-04-01T00:00:00Z', null, {
    theory: '2027-04-10T09:59:00Z',
    practice: '2027-04-10T09:59:00Z',
  });
  localCert(service, 'tiny-gap', '2027-04-10T10:00:00Z', null, {
    theory: '2027-05-01T00:00:00Z',
    practice: '2027-05-01T00:00:00Z',
  });
  service.store.add('shifts', {
    id: 'shift-gap', region: 'river-zone', role: 'press', contractor: 'fen',
    from: '2027-04-10T08:00:00Z', until: '2027-04-10T12:00:00Z',
  });
  const { evaluation, letter } = service.requestProof(issuerRiver, {
    shift: 'shift-gap', worker: 'tiny-gap', at: '2027-03-01T00:00:00Z',
  });
  assert.equal(letter.status, 'denied');
  assert.equal(evaluation.gaps.length, 1);
  assert.deepEqual(
    { from: evaluation.gaps[0].from, until: evaluation.gaps[0].until },
    { from: '2027-04-10T09:59:00Z', until: '2027-04-10T10:00:00Z' },
  );
  assert.equal(evaluation.gaps[0].reason, GAP_REASONS.CERTIFICATE_EXPIRED);
});

test('班前证据推翻：班组可见状态翻转为 denied，并提示补人', async () => {
  const service = await setup();
  const cert = localCert(service, 'early', '2027-04-01T00:00:00Z', null, {
    theory: '2027-06-01T00:00:00Z',
    practice: '2027-06-01T00:00:00Z',
  });
  service.store.add('shifts', {
    id: 'shift-early', region: 'river-zone', role: 'press', contractor: 'fen',
    from: '2027-04-10T08:00:00Z', until: '2027-04-10T12:00:00Z',
  });
  const { letter } = service.requestProof(contractorFen, {
    shift: 'shift-early', worker: 'early', at: '2027-04-01T01:00:00Z',
  });
  assert.equal(letter.status, 'confirmed');
  // 4/5 复核推翻该证照依赖的一科（班次开始前）
  const theoryScore = service.get('scores', cert.scope[0]);
  service.reviseScore(reviewer, {
    score: theoryScore.id, at: '2027-04-05T00:00:00Z', passed: false, reason: '复查不合格',
  });
  const updated = service.get('proofLetters', letter.id);
  assert.equal(updated.status, 'denied');
  const impact = service.get('letterImpacts', updated.impacts[0]);
  assert.equal(impact.phase, 'before-start');
  assert.match(impact.note, /补人/);
  assert.equal(impact.gaps[0].reason, GAP_REASONS.CERTIFICATE_SUSPENDED);
});

test('班中证据问题：原结论不改写，挂主管立即复核告警', async () => {
  const service = await setup();
  const cert = localCert(service, 'mid', '2027-04-01T00:00:00Z', null, {
    theory: '2027-06-01T00:00:00Z',
    practice: '2027-06-01T00:00:00Z',
  });
  service.store.add('shifts', {
    id: 'shift-mid', region: 'river-zone', role: 'press', contractor: 'fen',
    from: '2027-04-10T08:00:00Z', until: '2027-04-10T16:00:00Z',
  });
  const { letter } = service.requestProof(contractorFen, {
    shift: 'shift-mid', worker: 'mid', at: '2027-04-01T01:00:00Z',
  });
  const practiceScore = service.get('scores', cert.scope[1]);
  service.reviseScore(reviewer, {
    score: practiceScore.id, at: '2027-04-10T10:00:00Z', revoked: true, passed: false,
  });
  const updated = service.get('proofLetters', letter.id);
  // 当时发给班组的结论保留
  assert.equal(updated.status, 'confirmed');
  assert.equal(updated.alert.level, 'SUPERVISOR_REVIEW_REQUIRED');
  const impact = service.get('letterImpacts', updated.impacts[0]);
  assert.equal(impact.phase, 'in-progress');
  assert.match(impact.note, /立即复核/);
});

test('班后获知问题：只记事后影响，不把历史结论改成从未确认', async () => {
  const service = await setup();
  const cert = localCert(service, 'late', '2027-04-01T00:00:00Z', null, {
    theory: '2027-06-01T00:00:00Z',
    practice: '2027-06-01T00:00:00Z',
  });
  service.store.add('shifts', {
    id: 'shift-late', region: 'river-zone', role: 'press', contractor: 'fen',
    from: '2027-04-10T08:00:00Z', until: '2027-04-10T12:00:00Z',
  });
  const { letter } = service.requestProof(contractorFen, {
    shift: 'shift-late', worker: 'late', at: '2027-04-01T01:00:00Z',
  });
  const theoryScore = service.get('scores', cert.scope[0]);
  service.reviseScore(reviewer, {
    score: theoryScore.id, at: '2027-04-12T00:00:00Z', passed: false,
  });
  const updated = service.get('proofLetters', letter.id);
  assert.equal(updated.status, 'confirmed');
  assert.equal(updated.alert, undefined);
  const impact = service.get('letterImpacts', updated.impacts[0]);
  assert.equal(impact.phase, 'after-end');
  assert.match(impact.note, /事后获知/);
});

test('联调回放：装载时 16:20 的复核对进行中的 night-r 产生主管复核告警', async () => {
  const service = await setup();
  const letter = service.get('proofLetters', 'letter-r');
  const impact = service.get('letterImpacts', letter.impacts[0]);
  assert.equal(impact.phase, 'in-progress');
  assert.equal(impact.cause, 'SCORE_OVERTURNED');
  assert.equal(letter.alert.level, 'SUPERVISOR_REVIEW_REQUIRED');
  // 历史结论不被改写：letter 仍保留当时覆盖信息，只额外携带告警
  assert.equal(letter.coveredFrom, '2027-02-01T15:30:00Z');
});

test('承包商视图：只看自己班组的排程、缺口时段与原因类别，看不到分数', async () => {
  const service = await setup();
  const view = service.contractorView(contractorFen);
  const night = view.find((item) => item.shift === 'night-r');
  assert.ok(night);
  // 不含任何分数/证照编号字段
  const serialized = JSON.stringify(view);
  assert.ok(!serialized.includes('score-'));
  assert.ok(!serialized.includes('cert-r1'));
  const status = night.statuses.find((item) => item.worker === 'lark');
  assert.equal(status.proofStatus, 'denied');
  assert.equal(status.gaps[0].reasonCategory, GAP_REASONS.CERTIFICATE_SUSPENDED);
  assert.ok(status.alert);

  // 另一个承包商无权查看 fen 的班次
  assert.throws(
    () => service.contractorView(contractorSalt, 'night-r'),
    /不存在/,
  );
  // 承包商视图中看不到其他承包商的班次
  const saltView = service.contractorView(contractorSalt);
  assert.ok(saltView.every((item) => item.shift === 'day-n'));
});

test('无任何证照时缺口原因类别为 NO_CERTIFICATE', async () => {
  const service = await setup();
  const evaluation = service.evaluateShift('day-n', 'nobody', '2027-01-30T00:00:00Z');
  assert.equal(evaluation.confirmed, false);
  assert.equal(evaluation.gaps[0].reason, GAP_REASONS.NO_CERTIFICATE);
});

test('混合接续：前证有效、后证暂停时，缺口只落在后段并标注暂停原因', async () => {
  const service = await setup();
  // 第一张证覆盖 08:00–10:00 且保持有效
  localCert(service, 'mix', '2027-04-10T08:00:00Z', null, {
    theory: '2027-04-10T10:00:00Z',
    practice: '2027-04-10T10:00:00Z',
  });
  // 第二张证 10:00 起接续，随后因依据推翻被暂停
  const second = localCert(service, 'mix', '2027-04-10T10:00:00Z', null, {
    theory: '2027-05-01T00:00:00Z',
    practice: '2027-05-01T00:00:00Z',
  });
  service.store.add('shifts', {
    id: 'shift-mix', region: 'river-zone', role: 'press', contractor: 'fen',
    from: '2027-04-10T08:00:00Z', until: '2027-04-10T14:00:00Z',
  });
  const before = service.requestProof(issuerRiver, {
    shift: 'shift-mix', worker: 'mix', at: '2027-04-01T00:00:00Z',
  });
  assert.equal(before.letter.status, 'confirmed');

  const theoryScore = service.get('scores', second.scope[0]);
  service.reviseScore(reviewer, {
    score: theoryScore.id, at: '2027-04-05T00:00:00Z', passed: false,
  });
  const after = service.evaluateShift('shift-mix', 'mix', '2027-04-06T00:00:00Z');
  assert.equal(after.confirmed, false);
  assert.equal(after.gaps.length, 1);
  assert.deepEqual(
    { from: after.gaps[0].from, until: after.gaps[0].until },
    { from: '2027-04-10T10:00:00Z', until: '2027-04-10T14:00:00Z' },
  );
  assert.equal(after.gaps[0].reason, GAP_REASONS.CERTIFICATE_SUSPENDED);
});

test('证照确认不成立：班次缺口标注 CERTIFICATE_INVALID 且完全不产生覆盖', async () => {
  const service = await setup();
  const certificate = localCert(service, 'void-worker', '2027-04-01T00:00:00Z', null, {
    theory: '2027-06-01T00:00:00Z',
    practice: '2027-06-01T00:00:00Z',
  });
  service.store.add('shifts', {
    id: 'shift-void', region: 'river-zone', role: 'press', contractor: 'fen',
    from: '2027-04-10T08:00:00Z', until: '2027-04-10T12:00:00Z',
  });
  service.invalidateCertificate(
    issuerRiver, certificate.id, '查实造假', '2027-04-05T00:00:00Z',
  );
  const evaluation = service.evaluateShift('shift-void', 'void-worker', '2027-04-06T00:00:00Z');
  assert.equal(evaluation.confirmed, false);
  assert.equal(evaluation.gaps.length, 1);
  assert.equal(evaluation.gaps[0].reason, GAP_REASONS.CERTIFICATE_INVALID);
});
