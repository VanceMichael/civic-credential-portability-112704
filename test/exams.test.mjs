import assert from 'node:assert/strict';
import test from 'node:test';

import { CredentialService } from '../src/service.js';

async function setup() {
  return CredentialService.fromFile(new URL('../data/records.json', import.meta.url));
}

const centreR = { id: 'op-r', type: 'centre-operator', centreId: 'school-r' };
const centreN = { id: 'op-n', type: 'centre-operator', centreId: 'school-n' };
const issuerRiver = { id: 'issuer-r', type: 'issuer', region: 'river-zone' };
const self = { id: 'worker-self', type: 'contractor', contractorId: 'fen' };

test('席位：超出容量进候补，取消预留后候补按资格重新判定', async () => {
  const service = await setup();
  service.defineActor(centreR);
  // 资料中 exam-r1 只有 1 个座位：lark 预留、ash 候补
  const lark = service.get('examClaims', 'claim-la');
  const ash = service.get('examClaims', 'claim-as');
  assert.equal(lark.status, 'reserved');
  assert.equal(ash.status, 'waitlisted');

  const { promoted } = service.cancelClaim(self, 'claim-la', '2027-02-01T11:00:00Z');
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].worker, 'ash');
  assert.equal(service.get('examClaims', 'claim-as').status, 'reserved');
});

test('预约不等于可续证：签到按补考当天规则判定，互认停止后 lark 被拒、ash 递补', async () => {
  const service = await setup();
  service.defineActor(centreR);
  service.lockExam(centreR, 'exam-r1', '2027-02-01T12:00:00Z');

  // lark 15:00 签到：14:00 互认已停止，其引用的外区 theory 不再被采信
  const lark = service.checkIn(centreR, {
    exam: 'exam-r1',
    worker: 'lark',
    at: '2027-02-01T15:00:00Z',
  });
  assert.equal(lark.admitted, false);
  assert.equal(lark.claim.status, 'denied');
  assert.ok(lark.eligibility.notices.some((n) => n.type === 'RULE_CHANGED_AFTER_CLAIM' || n.type === 'SUBJECT_NOT_QUALIFIED'));
  // 被拒原因可定位到互认停止
  assert.ok(
    JSON.stringify(lark.eligibility).includes('RECIPROCITY_STOPPED'),
  );

  // 空出的席位触发候补重判：ash 是 river 本片区 theory 有效成绩，具备资格
  assert.equal(lark.promoted.length, 1);
  assert.equal(lark.promoted[0].worker, 'ash');

  const ash = service.checkIn(centreR, {
    exam: 'exam-r1',
    worker: 'ash',
    at: '2027-02-01T15:05:00Z',
  });
  assert.equal(ash.admitted, true);
  assert.equal(ash.claim.status, 'checked-in');
});

test('已签到的科目不因补报挪给他人：锁定后新报考被拒，候补也不能挤已签到者', async () => {
  const service = await setup();
  service.defineActor(centreR);
  // 先为两名候选人送出本片区 practice 有效成绩
  for (const worker of ['beam', 'cobb']) {
    service.receiveScore(centreR, {
      worker, role: 'press', subject: 'practice', passed: true,
      until: '2028-01-01T00:00:00Z', at: '2027-01-30T00:00:00Z',
    });
  }
  // exam-r2 有 2 个座位
  const a = service.reserveSeat(self, { exam: 'exam-r2', worker: 'beam', at: '2027-02-01T10:00:00Z' });
  const b = service.reserveSeat(self, { exam: 'exam-r2', worker: 'cobb', at: '2027-02-01T10:01:00Z' });
  assert.equal(a.claim.status, 'reserved');
  assert.equal(b.claim.status, 'reserved');
  service.lockExam(centreR, 'exam-r2', '2027-02-01T12:00:00Z');
  // 锁定后报名一律拒绝
  assert.throws(
    () => service.reserveSeat(self, { exam: 'exam-r2', worker: 'dane', at: '2027-02-01T12:30:00Z' }),
    /已下发锁定/,
  );
  // beam 先签到
  const beam = service.checkIn(centreR, { exam: 'exam-r2', worker: 'beam', at: '2027-02-01T16:55:00Z' });
  assert.equal(beam.admitted, true);
  // 模拟 cobb 成绩在签到前被复核推翻：签到被拒，席位空出；beam 的签到不受任何影响
  const cobbScore = service.list('scores').find((s) => s.worker === 'cobb' && s.subject === 'practice');
  const reviewer = { id: 'rev-1', type: 'reviewer' };
  service.defineActor(reviewer);
  service.reviseScore(reviewer, { score: cobbScore.id, at: '2027-02-01T16:50:00Z', passed: false });
  const cobb = service.checkIn(centreR, { exam: 'exam-r2', worker: 'cobb', at: '2027-02-01T16:56:00Z' });
  assert.equal(cobb.admitted, false);
  assert.equal(service.get('examClaims', beam.claim.id).status, 'checked-in');
});

test('候补资格重新判定：资格不成立的候补不占座，恢复资格后可再递补', async () => {
  const service = await setup();
  service.defineActor(centreR);
  // 新建 1 座考场：第一候选人占位，第二人候补
  const exam = service.createExam(centreR, {
    role: 'press', subject: 'practice', from: '2027-02-05T09:00:00Z', seats: 1,
  });
  service.reserveSeat(self, { exam: exam.id, worker: 'lark', at: '2027-02-01T09:00:00Z' });
  const wait = service.reserveSeat(self, { exam: exam.id, worker: 'ash', at: '2027-02-01T09:01:00Z' });
  assert.equal(wait.claim.status, 'waitlisted');
  service.lockExam(centreR, exam.id, '2027-02-04T00:00:00Z');
  // ash 没有 practice 成绩，即便空座也不能递补
  const promotedEmpty = service.rejudgeWaitlist(exam.id, '2027-02-04T01:00:00Z');
  assert.deepEqual(promotedEmpty, []);
  assert.equal(service.get('examClaims', wait.claim.id).status, 'waitlisted');

  // 给 ash 补一版本片区 practice 通过成绩后，重判即可递补
  service.receiveScore(centreR, {
    worker: 'ash', role: 'press', subject: 'practice', passed: true,
    until: '2028-01-01T00:00:00Z', at: '2027-02-04T05:00:00Z',
  });
  const promoted = service.rejudgeWaitlist(exam.id, '2027-02-04T06:00:00Z');
  // 注意：lark 仍占座，所以仍无法递补；先取消 lark 再判
  assert.deepEqual(promoted, []);
  const larkClaim = service.list('examClaims').find((c) => c.exam === exam.id && c.worker === 'lark');
  service.cancelClaim(self, larkClaim.id, '2027-02-04T07:00:00Z');
  const afterCancel = service.list('examClaims').find((c) => c.id === wait.claim.id);
  assert.equal(afterCancel.status, 'reserved');
});

test('锁定科目与人员；只能给已签到者录本考点成绩', async () => {
  const service = await setup();
  service.defineActor(centreR);
  // lark 先在锁定前报名 r2（其 practice 为本片区有效成绩）
  service.reserveSeat(self, { exam: 'exam-r2', worker: 'lark', at: '2027-02-01T10:30:00Z' });
  service.lockExam(centreR, 'exam-r2', '2027-02-01T12:00:00Z');
  // 未签到不能录成绩
  assert.throws(
    () => service.enterScore(centreR, {
      exam: 'exam-r2', worker: 'lark', passed: true,
      until: '2028-01-01T00:00:00Z', at: '2027-02-01T18:00:00Z',
    }),
    /已签到/,
  );
  const checkIn = service.checkIn(centreR, { exam: 'exam-r2', worker: 'lark', at: '2027-02-01T16:59:00Z' });
  assert.equal(checkIn.admitted, true);
  const score = service.enterScore(centreR, {
    exam: 'exam-r2', worker: 'lark', passed: true,
    until: '2028-01-01T00:00:00Z', at: '2027-02-01T18:00:00Z',
  });
  assert.equal(score.centre, 'school-r');
  assert.equal(score.subject, 'practice');

  // 外考点不能动该考场
  service.defineActor(centreN);
  assert.throws(
    () => service.lockExam(centreN, 'exam-r2'),
    /自己的考场/,
  );
});

test('事后改成绩只能由复核员提出，原考点出分与复核各自留档', async () => {
  const service = await setup();
  const reviewer = { id: 'rev-1', type: 'reviewer' };
  service.defineActor(reviewer);
  service.defineActor(centreR);
  // 考点操作员无权复核
  assert.throws(
    () => service.reviseScore(centreR, { score: 'score-rp', at: '2027-02-02T00:00:00Z', passed: false }),
    /复核员/,
  );
  const { revision } = service.reviseScore(reviewer, {
    score: 'score-rp',
    at: '2027-02-02T00:00:00Z',
    passed: false,
    reason: '录像复核发现违规',
  });
  assert.ok(revision.id);
  // 原成绩仍在，复核单独成档
  assert.equal(service.get('scores', 'score-rp').passed, true);
  assert.ok(service.list('scoreRevisions').some((item) => item.score === 'score-rp' && item.passed === false));
  // 审计日志分别记录出分接收与复核动作
  const actions = service.auditLog().map((entry) => entry.action);
  assert.ok(actions.includes('score.revise'));
});

test('报名后规则变化：新增科目会在资格检查中明确指出需要补什么', async () => {
  const service = await setup();
  service.defineActor(centreR);
  service.defineActor(issuerRiver);
  const exam = service.createExam(centreR, {
    role: 'press', subject: 'safety', from: '2027-03-10T09:00:00Z', seats: 2,
  });
  const claim = service.reserveSeat(self, { exam: exam.id, worker: 'lark', at: '2027-02-20T09:00:00Z' });
  service.publishRuleVersion(issuerRiver, {
    region: 'river-zone',
    from: '2027-03-01T00:00:00Z',
    roles: { press: ['theory', 'practice', 'safety'] },
  });
  const eligibility = service.eligibility(exam.id, claim.claim.id, '2027-03-05T00:00:00Z');
  assert.equal(eligibility.subjectEligible, false);
  const notice = eligibility.notices.find((item) => item.type === 'RULE_CHANGED_AFTER_CLAIM');
  assert.ok(notice);
  assert.deepEqual(notice.diff.roleChanges[0].addedSubjects, ['safety']);
});
