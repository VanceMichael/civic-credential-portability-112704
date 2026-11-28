import assert from 'node:assert/strict';
import test from 'node:test';

import { CredentialService } from '../src/service.js';

async function setup() {
  return CredentialService.fromFile(new URL('../data/records.json', import.meta.url));
}

const issuerRiver = { id: 'issuer-r', type: 'issuer', region: 'river-zone' };
const centreR = { id: 'op-r', type: 'centre-operator', centreId: 'school-r' };

test('互认：截止时间与政策通告各自独立，左闭右开判定', async () => {
  const service = await setup();
  // 通告 14:00 生效前：互认在 accepts 截止 16:00 内有效
  assert.deepEqual(
    service.acceptance('river-zone', 'school-n', 'theory', '2027-02-01T13:59:59Z').allowed,
    true,
  );
  // 14:00 政策通告停止互认
  const stopped = service.acceptance('river-zone', 'school-n', 'theory', '2027-02-01T14:00:00Z');
  assert.equal(stopped.allowed, false);
  assert.equal(stopped.reason, 'RECIPROCITY_STOPPED');
  // 16:00 后即使没有通告，accepts 截止本身也已过期
  const expired = service.acceptance('river-zone', 'school-n', 'theory', '2027-02-01T16:00:00Z');
  assert.equal(expired.allowed, false);
  // 未列入互认范围的科目
  const notInScope = service.acceptance('river-zone', 'school-n', 'practice', '2027-02-01T10:00:00Z');
  assert.equal(notInScope.allowed, false);
  assert.equal(notInScope.reason, 'NOT_IN_SCOPE');
});

test('规则按施行日期版本化，旧版本仍可被历史时点引用', async () => {
  const service = await setup();
  service.defineActor(issuerRiver);
  service.publishRuleVersion(issuerRiver, {
    region: 'river-zone',
    from: '2027-03-01T00:00:00Z',
    roles: { press: ['theory', 'practice', 'safety'] },
    accepts: [],
  });
  const before = service.ruleVersion('river-zone', '2027-02-01T00:00:00Z');
  const after = service.ruleVersion('river-zone', '2027-03-01T00:00:00Z');
  assert.deepEqual(before.roles.press, ['theory', 'practice']);
  assert.deepEqual(after.roles.press, ['theory', 'practice', 'safety']);
  // 新版本施行时间不能回退
  assert.throws(
    () => service.publishRuleVersion(issuerRiver, {
      region: 'river-zone',
      from: '2027-02-15T00:00:00Z',
      roles: { press: ['theory'] },
    }),
    /必须晚于当前版本/,
  );
});

test('报名后规则变化：diff 指出新增科目，补报提示需要补 safety', async () => {
  const service = await setup();
  service.defineActor(issuerRiver);
  const diff = service.ruleDiff('river-zone', '2027-02-01T10:00:00Z', '2027-02-01T15:00:00Z');
  // 当前资料中尚无新发布版本，差异为空
  assert.deepEqual(diff.roleChanges, []);
  service.publishRuleVersion(issuerRiver, {
    region: 'river-zone',
    from: '2027-02-01T14:30:00Z',
    roles: { press: ['theory', 'practice', 'safety'] },
  });
  const changed = service.ruleDiff('river-zone', '2027-02-01T10:00:00Z', '2027-02-01T15:00:00Z');
  assert.deepEqual(changed.roleChanges[0].addedSubjects, ['safety']);
});

test('成绩可用性：工种、有效期、来源考点、互认四条同时满足', async () => {
  const service = await setup();
  // lark 的 school-n theory 成绩在 13:00 可被 river 采信
  const ok = service.usability('river-zone', 'press', 'score-nt', '2027-02-01T13:00:00Z');
  assert.equal(ok.usable, true);
  assert.equal(ok.kind, 'external');
  // 14:00 后互认停止，同一条成绩不再可采信，但成绩本身仍在有效期内
  const blocked = service.usability('river-zone', 'press', 'score-nt', '2027-02-01T14:30:00Z');
  assert.equal(blocked.usable, false);
  assert.equal(blocked.reason, 'RECIPROCITY_STOPPED');
  // 本片区成绩不受互认通告影响
  const local = service.usability('river-zone', 'press', 'score-rp', '2027-02-01T14:30:00Z');
  assert.equal(local.usable, true);
  assert.equal(local.kind, 'local');
  // 成绩自身到期
  const expired = service.usability('river-zone', 'press', 'score-rt', '2027-03-01T00:00:00Z');
  assert.equal(expired.usable, false);
  assert.equal(expired.reason, 'SCORE_EXPIRED');
});

test('复核推翻单科：原文留档，截至时点取最后一条结论', async () => {
  const service = await setup();
  const reviewer = { id: 'rev-1', type: 'reviewer' };
  service.defineActor(reviewer);
  // 装载时已回放 rev-nt（16:20 推翻 score-nt）
  const after = service.scoreState('score-nt', '2027-02-01T16:30:00Z');
  assert.equal(after.passed, false);
  assert.ok(after.revision);
  // 历史时点结论仍是通过
  const before = service.scoreState('score-nt', '2027-02-01T16:00:00Z');
  assert.equal(before.passed, true);
  // 原成绩记录未被删除
  assert.equal(service.get('scores', 'score-nt').passed, true);
  // 复核员再次复核恢复通过
  service.reviseScore(reviewer, {
    score: 'score-nt',
    at: '2027-02-02T09:00:00Z',
    passed: true,
    reason: '补证成立',
  });
  const restored = service.scoreState('score-nt', '2027-02-02T10:00:00Z');
  assert.equal(restored.passed, true);
});

test('合作考点分次送分：缺科期间评估为 incomplete，补齐后 complete', async () => {
  const service = await setup();
  service.defineActor(centreR);
  service.defineActor(issuerRiver);
  service.publishRuleVersion(issuerRiver, {
    region: 'river-zone',
    from: '2027-03-01T00:00:00Z',
    roles: { press: ['theory', 'practice', 'safety'] },
  });
  // 互认已于 2 月终止，3 月只能靠本片区成绩；先送两科，safety 仍缺
  service.receiveScore(centreR, {
    worker: 'lark', role: 'press', subject: 'theory', passed: true,
    until: '2028-01-01T00:00:00Z', at: '2027-03-02T01:00:00Z', batch: 'batch-1',
  });
  service.receiveScore(centreR, {
    worker: 'lark', role: 'press', subject: 'practice', passed: true,
    until: '2028-01-01T00:00:00Z', at: '2027-03-02T01:00:00Z', batch: 'batch-1',
  });
  const before = service.assessEvidence({
    region: 'river-zone',
    role: 'press',
    worker: 'lark',
    t: '2027-03-02T02:00:00Z',
  });
  assert.equal(before.status, 'incomplete');
  assert.deepEqual(before.subjects.find((s) => s.subject === 'safety').reason, 'NO_EVIDENCE');

  // 同批先挂科一次，结论仍是缺科待定
  service.receiveScore(centreR, {
    worker: 'lark',
    role: 'press',
    subject: 'safety',
    passed: false,
    until: '2028-01-01T00:00:00Z',
    at: '2027-03-02T03:00:00Z',
    batch: 'batch-1',
  });
  const stillMissing = service.assessEvidence({
    region: 'river-zone',
    role: 'press',
    worker: 'lark',
    t: '2027-03-02T04:00:00Z',
  });
  assert.equal(stillMissing.status, 'incomplete');

  // 第二次送分补齐
  service.receiveScore(centreR, {
    worker: 'lark',
    role: 'press',
    subject: 'safety',
    passed: true,
    until: '2028-01-01T00:00:00Z',
    at: '2027-03-03T01:00:00Z',
    batch: 'batch-2',
  });
  const complete = service.assessEvidence({
    region: 'river-zone',
    role: 'press',
    worker: 'lark',
    t: '2027-03-03T02:00:00Z',
  });
  assert.equal(complete.status, 'complete');
});

test('外区撤销与复核只影响对应科目结论', async () => {
  const service = await setup();
  const reviewer = { id: 'rev-1', type: 'reviewer' };
  service.defineActor(reviewer);
  const result = service.reviseScore(reviewer, {
    score: 'score-rp',
    at: '2027-01-20T00:00:00Z',
    revoked: true,
    passed: false,
    reason: '考场违规撤销',
  });
  const state = service.scoreState('score-rp', '2027-01-21T00:00:00Z');
  assert.equal(state.revoked, true);
  assert.equal(state.passed, false);
  // 另一条成绩不受牵连
  assert.equal(service.scoreState('score-nt', '2027-01-21T00:00:00Z').passed, true);
  assert.ok(result.affected.every((item) => item.cause === 'SCORE_REVOKED'));
});
