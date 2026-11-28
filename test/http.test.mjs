import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../src/http.js';
import { CredentialService } from '../src/service.js';

const DATA_URL = new URL('../data/records.json', import.meta.url);

async function start() {
  const service = await CredentialService.fromFile(DATA_URL);
  const server = createApp(service);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return { server, service, port };
}

function headers(actor, ref) {
  return {
    'content-type': 'application/json',
    'x-actor-id': actor.id,
    'x-actor-type': actor.type,
    ...(ref ? { 'x-actor-ref': ref } : {}),
  };
}

async function call(port, method, path, body, actor, ref) {
  const init = {
    method,
    headers: headers(actor, ref),
  };
  if (method !== 'GET' && method !== 'HEAD' && body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`http://localhost:${port}${path}`, init);
  const json = await response.json();
  return { status: response.status, json };
}

const centreR = { id: 'op-r', type: 'centre-operator' };
const issuerRiver = { id: 'issuer-r', type: 'issuer' };
const reviewer = { id: 'rev-1', type: 'reviewer' };
const contractorFen = { id: 'c-fen', type: 'contractor' };
const contractorSalt = { id: 'c-salt', type: 'contractor' };

test('端到端：查规则 → 锁考场 → 当天签到被互认停止拒绝 → 候补递补 → 出分', async () => {
  const { server, port } = await start();
  try {
    // 互认状态查询
    const acceptance = await call(port, 'GET',
      '/regions/river-zone/acceptance?issuer=school-n&subject=theory&at=2027-02-01T15:00:00Z',
      undefined, reviewer);
    assert.equal(acceptance.status, 200);
    assert.equal(acceptance.json.status.allowed, false);
    assert.equal(acceptance.json.status.reason, 'RECIPROCITY_STOPPED');

    // 锁定考场
    const locked = await call(port, 'POST', '/exams/exam-r1/lock', { at: '2027-02-01T12:00:00Z' }, centreR, 'school-r');
    assert.equal(locked.status, 200);
    assert.equal(locked.json.locked, true);

    // lark 签到被拒
    const denied = await call(port, 'POST', '/exams/exam-r1/check-ins', {
      worker: 'lark', at: '2027-02-01T15:00:00Z',
    }, centreR, 'school-r');
    assert.equal(denied.status, 200);
    assert.equal(denied.json.admitted, false);
    assert.equal(denied.json.claim.status, 'denied');
    // ash 候补递补并可签到
    assert.equal(denied.json.promoted[0].worker, 'ash');
    const admitted = await call(port, 'POST', '/exams/exam-r1/check-ins', {
      worker: 'ash', at: '2027-02-01T15:05:00Z',
    }, centreR, 'school-r');
    assert.equal(admitted.json.admitted, true);

    // ash 出分
    const score = await call(port, 'POST', '/exams/exam-r1/scores', {
      worker: 'ash', passed: true, until: '2028-01-01T00:00:00Z', at: '2027-02-01T16:00:00Z',
    }, centreR, 'school-r');
    assert.equal(score.status, 200);
    assert.equal(score.json.subject, 'theory');
  } finally {
    server.close();
  }
});

test('端到端：发证材料完整 → 签发 → 复核暂停 → 替换恢复，全程留审计', async () => {
  const { server, port, service } = await start();
  try {
    // 先送两科本地成绩
    for (const subject of ['theory', 'practice']) {
      const res = await call(port, 'POST', '/scores', {
        worker: 'pike', role: 'press', subject, passed: true,
        until: '2028-01-01T00:00:00Z', at: '2027-01-15T00:00:00Z',
      }, centreR, 'school-r');
      assert.equal(res.status, 200);
    }
    const apply = await call(port, 'POST', '/cert-cases', {
      region: 'river-zone', role: 'press', worker: 'pike', at: '2027-01-16T00:00:00Z',
    }, issuerRiver, 'river-zone');
    assert.equal(apply.json.status, 'complete');
    const issued = await call(port, 'POST', `/cert-cases/${apply.json.id}/issue`, { from: '2027-01-16T00:00:00Z' },
      issuerRiver, 'river-zone');
    assert.equal(issued.json.status, 'issued');
    const certId = issued.json.id;

    // 复核推翻 theory
    const theoryScore = service.list('scores').find((s) => s.worker === 'pike' && s.subject === 'theory');
    const revision = await call(port, 'POST', `/scores/${theoryScore.id}/revisions`, {
      at: '2027-02-01T00:00:00Z', passed: false, reason: '复核不合格',
    }, reviewer);
    assert.equal(revision.status, 200);
    assert.equal(service.get('certificates', certId).status, 'suspended');

    // 新成绩替代
    const newScore = await call(port, 'POST', '/scores', {
      worker: 'pike', role: 'press', subject: 'theory', passed: true,
      until: '2028-06-01T00:00:00Z', at: '2027-02-02T00:00:00Z',
    }, centreR, 'school-r');
    const replaced = await call(port, 'POST', `/certificates/${certId}/replace-evidence`, {
      replacedScore: theoryScore.id, newScore: newScore.json.id, at: '2027-02-03T00:00:00Z',
    }, issuerRiver, 'river-zone');
    assert.equal(replaced.json.restored, true);

    // 审计可查
    const audit = await call(port, 'GET', '/audit-log', undefined, reviewer);
    const actions = audit.json.items.map((entry) => entry.action);
    for (const action of ['score.revise', 'cert.suspend', 'cert.replace']) {
      assert.ok(actions.includes(action), `缺少审计动作 ${action}`);
    }
  } finally {
    server.close();
  }
});

test('端到端：承包商只能看自己班组，视图不含分数与证照编号', async () => {
  const { server, port } = await start();
  try {
    const fen = await call(port, 'GET', '/contractor-view', undefined, contractorFen, 'fen');
    assert.equal(fen.status, 200);
    assert.ok(fen.json.some((item) => item.shift === 'night-r'));
    const serialized = JSON.stringify(fen.json);
    assert.ok(!serialized.includes('score-'));
    assert.ok(!serialized.includes('cert-'));

    const salt = await call(port, 'GET', '/contractor-view?shift=night-r', {}, contractorSalt, 'salt');
    assert.equal(salt.status, 404);
  } finally {
    server.close();
  }
});

test('端到端：跨考点越权操作被拒；发证方不能操作外片区', async () => {
  const { server, port } = await start();
  try {
    const wrongCentre = await call(port, 'POST', '/exams/exam-r1/lock', {},
      { id: 'op-n', type: 'centre-operator' }, 'school-n');
    assert.equal(wrongCentre.status, 403);
    const wrongRegion = await call(port, 'POST', '/cert-cases', {
      region: 'north-zone', role: 'press', worker: 'x', at: '2027-01-01T00:00:00Z',
    }, issuerRiver, 'river-zone');
    assert.equal(wrongRegion.status, 403);
    // 未带参与者头不允许写操作
    const noActor = await fetch(`http://localhost:${port}/exams/exam-r1/lock`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(noActor.status, 403);
  } finally {
    server.close();
  }
});

test('端到端：班次证明与缺口原因可通过接口获取', async () => {
  const { server, port } = await start();
  try {
    const evaluation = await call(port, 'GET',
      '/shifts/night-r/evaluation?worker=lark&at=2027-01-30T08:00:00Z',
      undefined, reviewer);
    assert.equal(evaluation.status, 200);
    assert.equal(evaluation.json.confirmed, false);
    assert.ok(evaluation.json.gaps.length >= 1);
  } finally {
    server.close();
  }
});
