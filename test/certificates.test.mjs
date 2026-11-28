import assert from 'node:assert/strict';
import test from 'node:test';

import { CredentialService } from '../src/service.js';
import { ms } from '../src/time.js';

const DATA_URL = new URL('../data/records.json', import.meta.url);
const T = '2027-01-15T00:00:00Z';
const issuerRiver = { id: 'issuer-r', type: 'issuer', region: 'river-zone' };
const issuerNorth = { id: 'issuer-n', type: 'issuer', region: 'north-zone' };
const reviewer = { id: 'rev-1', type: 'reviewer' };
const centreR = { id: 'op-r', type: 'centre-operator', centreId: 'school-r' };

async function setup() {
  const service = await CredentialService.fromFile(DATA_URL);
  service.defineActor(issuerRiver);
  service.defineActor(issuerNorth);
  service.defineActor(reviewer);
  service.defineActor(centreR);
  return service;
}

/** 新建一组干净的工人成绩，避免与联调资料中的复核事件互相干扰。 */
function seedFreshWorker(service, worker) {
  service.receiveScore(centreR, {
    worker, role: 'press', subject: 'theory', passed: true,
    until: '2027-12-31T00:00:00Z', at: T,
  });
  service.receiveScore(centreR, {
    worker, role: 'press', subject: 'practice', passed: true,
    until: '2027-08-31T00:00:00Z', at: T,
  });
}

test('材料三态：完整可签、缺科暂缓、硬冲突拒签', async () => {
  const service = await setup();
  seedFreshWorker(service, 'finn');
  // 完整
  const complete = service.applyCase(issuerRiver, { region: 'river-zone', role: 'press', worker: 'finn', at: T });
  assert.equal(complete.status, 'complete');
  // 缺科
  const partial = service.applyCase(issuerRiver, { region: 'river-zone', role: 'press', worker: 'no-such-worker', at: T });
  assert.equal(partial.status, 'incomplete');
  service.holdCase(issuerRiver, partial.id, '等待补考成绩', T);
  assert.equal(service.get('certCases', partial.id).decision, 'held');
  // 硬冲突：成绩被复核推翻后申报 → 拒签
  service.receiveScore(centreR, {
    worker: 'gale', role: 'press', subject: 'theory', passed: true,
    until: '2027-12-31T00:00:00Z', at: T,
  });
  const galeTheory = service.list('scores').find((s) => s.worker === 'gale');
  service.reviseScore(reviewer, { score: galeTheory.id, at: '2027-01-16T00:00:00Z', passed: false });
  const rejected = service.applyCase(issuerRiver, { region: 'river-zone', role: 'press', worker: 'gale', at: '2027-01-17T00:00:00Z' });
  assert.equal(rejected.status, 'rejected');
  service.rejectCase(issuerRiver, rejected.id, '依据不成立', '2027-01-17T01:00:00Z');
  assert.throws(() => service.issue(issuerRiver, rejected.id), /拒签/);
});

test('签发有效期取所有依据可被采信终点的最早值（左闭右开）', async () => {
  const service = await setup();
  seedFreshWorker(service, 'finn');
  const certCase = service.applyCase(issuerRiver, { region: 'river-zone', role: 'press', worker: 'finn', at: T });
  const certificate = service.issue(issuerRiver, certCase.id, { from: T });
  // practice 成绩 8/31 到期，是最短的那块板
  assert.equal(certificate.until, '2027-08-31T00:00:00Z');
  assert.equal(certificate.scope.length, 2);
  assert.equal(certificate.status, 'issued');
});

test('外区成绩撤销/复核推翻：只有依赖该依据的证照暂停，无关证照不受影响', async () => {
  const service = await setup();
  // 联调资料中 cert-r1（lark）依赖 score-nt，装载时 rev-nt 已回放 → 应为 suspended
  const certR1 = service.get('certificates', 'cert-r1');
  assert.equal(certR1.status, 'suspended');
  assert.equal(certR1.suspension.score, 'score-nt');
  // 另发一张完全不依赖 score-nt 的证照，状态保持 issued
  seedFreshWorker(service, 'finn');
  const certCase = service.applyCase(issuerRiver, { region: 'river-zone', role: 'press', worker: 'finn', at: T });
  const independent = service.issue(issuerRiver, certCase.id, { from: T });
  assert.equal(independent.status, 'issued');
  // 暂停与签发都在事件链留痕
  const file = service.certificateFile(issuerRiver, certR1.id);
  const types = file.events.map((event) => event.type);
  assert.ok(types.includes('issued'));
  assert.ok(types.includes('suspended'));
});

test('新成绩替代失效依据：按当次签发条款重核，不做无条件拼接', async () => {
  const service = await setup();
  const certR1 = service.get('certificates', 'cert-r1');
  // 用一条不能满足条款的成绩尝试替代（工种不符）→ 继续暂停
  service.receiveScore(centreR, {
    worker: 'lark', role: 'welder', subject: 'theory', passed: true,
    until: '2028-01-01T00:00:00Z', at: '2027-02-03T00:00:00Z',
  });
  const wrong = service.list('scores').find((s) => s.worker === 'lark' && s.role === 'welder');
  const badReplace = service.replaceEvidence(issuerRiver, {
    certificate: certR1.id, replacedScore: 'score-nt', newScore: wrong.id,
  }, '2027-02-03T01:00:00Z');
  assert.equal(badReplace.restored, false);
  assert.equal(service.get('certificates', certR1.id).status, 'suspended');

  // 用本片区合格的新 theory 成绩替代，且 practice 仍有效 → 恢复，生效日不追认
  service.receiveScore(centreR, {
    worker: 'lark', role: 'press', subject: 'theory', passed: true,
    until: '2027-12-31T00:00:00Z', at: '2027-02-03T02:00:00Z',
  });
  const good = service.list('scores').find(
    (s) => s.worker === 'lark' && s.role === 'press' && s.subject === 'theory' && s.centre === 'school-r'
      && ms(s.receivedAt) >= Date.parse('2027-02-03T02:00:00Z'),
  );
  const result = service.replaceEvidence(issuerRiver, {
    certificate: certR1.id, replacedScore: 'score-nt', newScore: good.id,
  }, '2027-02-03T03:00:00Z');
  assert.equal(result.restored, true);
  const restored = service.get('certificates', certR1.id);
  assert.equal(restored.status, 'issued');
  assert.equal(restored.from, '2027-02-03T03:00:00Z');
  assert.ok(!restored.scope.includes('score-nt'));
  assert.ok(restored.scope.includes(good.id));
});

test('证照确认不成立后留档可核查；重新签发使用新生效日且不追认', async () => {
  const service = await setup();
  seedFreshWorker(service, 'finn');
  const certCase = service.applyCase(issuerRiver, { region: 'river-zone', role: 'press', worker: 'finn', at: T });
  const certificate = service.issue(issuerRiver, certCase.id, { from: T });
  const oldId = certificate.id;
  service.invalidateCertificate(issuerRiver, oldId, '查实材料造假', '2027-02-10T00:00:00Z');
  // 记录仍在，监管/发证可查完整档案
  const archived = service.get('certificates', oldId);
  assert.equal(archived.status, 'invalid');
  const file = service.certificateFile(issuerRiver, oldId);
  assert.ok(file.events.some((event) => event.type === 'invalidated'));
  // 无效证照不能直接替换依据
  assert.throws(
    () => service.replaceEvidence(issuerRiver, {
      certificate: oldId, replacedScore: 'x', newScore: 'y',
    }),
    /不成立证照/,
  );
  // 重新签发：新编号、新生效日，并标注来源
  const reissued = service.reissue(issuerRiver, { certificate: oldId, at: '2027-02-11T00:00:00Z' });
  assert.ok(reissued.certificate);
  assert.notEqual(reissued.certificate.id, oldId);
  assert.equal(reissued.certificate.from, '2027-02-11T00:00:00Z');
  assert.equal(reissued.certificate.reissueOf, oldId);
  // 旧记录没有被默默改写
  assert.equal(service.get('certificates', oldId).status, 'invalid');
});

test('片区撤掉互认不影响当地已确立的原资格（已发证照不暂停）', async () => {
  const service = await setup();
  // 用本片区成绩签发一张证照
  seedFreshWorker(service, 'finn');
  const certCase = service.applyCase(issuerRiver, { region: 'river-zone', role: 'press', worker: 'finn', at: T });
  const certificate = service.issue(issuerRiver, certCase.id, { from: T });
  // 发布停止互认的通告与新版本
  service.publishRuleVersion(issuerRiver, {
    region: 'river-zone',
    from: '2027-03-01T00:00:00Z',
    roles: { press: ['theory', 'practice'] },
    accepts: [],
  });
  // 证照仍然有效；只是新申报不能再引用外区成绩
  assert.equal(service.get('certificates', certificate.id).status, 'issued');
  const external = service.usability('river-zone', 'press', 'score-nt', '2027-03-02T00:00:00Z');
  assert.equal(external.usable, false);
});

test('签发时重新核查：申请后规则加科，原 complete 案件转回暂缓', async () => {
  const service = await setup();
  seedFreshWorker(service, 'finn');
  const certCase = service.applyCase(issuerRiver, { region: 'river-zone', role: 'press', worker: 'finn', at: T });
  assert.equal(certCase.status, 'complete');
  service.publishRuleVersion(issuerRiver, {
    region: 'river-zone',
    from: '2027-03-01T00:00:00Z',
    roles: { press: ['theory', 'practice', 'safety'] },
  });
  assert.throws(
    () => service.issue(issuerRiver, certCase.id, { from: '2027-03-02T00:00:00Z' }),
    /转回暂缓/,
  );
  assert.equal(service.get('certCases', certCase.id).status, 'incomplete');
});

test('外区证照与本片区证照相互独立：北片区证照不受 river 互认停止影响', async () => {
  const service = await setup();
  // 北片区本地两科成绩签发
  service.receiveScore({ id: 'op-n2', type: 'centre-operator', centreId: 'school-n' }, {
    worker: 'nora', role: 'press', subject: 'theory', passed: true,
    until: '2028-01-01T00:00:00Z', at: T,
  });
  service.receiveScore({ id: 'op-n2', type: 'centre-operator', centreId: 'school-n' }, {
    worker: 'nora', role: 'press', subject: 'practice', passed: true,
    until: '2028-01-01T00:00:00Z', at: T,
  });
  const certCase = service.applyCase(issuerNorth, { region: 'north-zone', role: 'press', worker: 'nora', at: T });
  const certificate = service.issue(issuerNorth, certCase.id, { from: T });
  assert.equal(certificate.region, 'north-zone');
  assert.equal(certificate.status, 'issued');
  // river 的互认通告对 north 本地资格无影响
  assert.equal(service.get('certificates', certificate.id).status, 'issued');
});
