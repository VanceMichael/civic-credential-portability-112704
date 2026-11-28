/**
 * 纯 node:http 的 JSON 接口。
 * 参与者通过请求头标识：
 *   x-actor-id   参与者编号
 *   x-actor-type centre-operator | reviewer | issuer | contractor | regulator
 *   x-actor-ref  关联标识（考点 / 片区 / 承包商编号，按类型解释）
 *
 * 所有写操作都会进入审计日志。
 */
import { createServer } from 'node:http';
import { CredentialService } from './service.js';
import { DomainError } from './errors.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function send(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new DomainError('PAYLOAD_TOO_LARGE', '请求体过大', 413));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new DomainError('INVALID_JSON', '请求体不是合法 JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

function actorFromHeaders(service, headers) {
  const id = headers['x-actor-id'];
  const type = headers['x-actor-type'];
  if (!id || !type) return null;
  const ref = headers['x-actor-ref'];
  const actor = service.defineActor({
    id,
    type,
    centreId: type === 'centre-operator' ? ref : null,
    region: type === 'issuer' ? ref : null,
    contractorId: type === 'contractor' ? ref : null,
  });
  return actor;
}

export function createApp(service) {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // 规则
  route('GET', /^\/regions\/([^/]+)\/rule-versions$/, (s, a, m, body, q) =>
    ({ items: s.ruleVersions(m[1]) }));
  route('POST', /^\/regions\/([^/]+)\/rule-versions$/, (s, actor, m, body) =>
    s.publishRuleVersion(actor, { ...body, region: m[1] }));
  route('GET', /^\/regions\/([^/]+)\/acceptance$/, (s, actor, m, body, q) => ({
    status: s.acceptance(m[1], q.get('issuer'), q.get('subject'), q.get('at')),
  }));

  // 考务
  route('POST', /^\/exams$/, (s, actor, m, body) => s.createExam(actor, body));
  route('GET', /^\/exams\/([^/]+)$/, (s, actor, m) => s.get('exams', m[1]));
  route('POST', /^\/exams\/([^/]+)\/claims$/, (s, actor, m, body) =>
    s.reserveSeat(actor, { ...body, exam: m[1] }));
  route('GET', /^\/exams\/([^/]+)\/claims$/, (s, actor, m) => ({
    items: s.list('examClaims').filter((claim) => claim.exam === m[1]),
  }));
  route('POST', /^\/exams\/([^/]+)\/lock$/, (s, actor, m, body) =>
    s.lockExam(actor, m[1], body?.at));
  route('POST', /^\/exams\/([^/]+)\/check-ins$/, (s, actor, m, body) =>
    s.checkIn(actor, { ...body, exam: m[1] }));
  route('POST', /^\/exams\/([^/]+)\/rejudge$/, (s, actor, m, body) => ({
    promoted: s.rejudgeWaitlist(m[1], body?.at),
  }));
  route('POST', /^\/exams\/([^/]+)\/scores$/, (s, actor, m, body) =>
    s.enterScore(actor, { ...body, exam: m[1] }));
  route('POST', /^\/claims\/([^/]+)\/cancel$/, (s, actor, m, body) =>
    s.cancelClaim(actor, m[1], body?.at));
  route('GET', /^\/claims\/([^/]+)\/eligibility$/, (s, actor, m, body, q) => {
    const claim = s.get('examClaims', m[1]);
    return s.eligibility(claim.exam, m[1], q.get('at'));
  });

  // 成绩与复核
  route('POST', /^\/scores$/, (s, actor, body0, body) => s.receiveScore(actor, body));
  route('POST', /^\/scores\/([^/]+)\/revisions$/, (s, actor, m, body) =>
    s.reviseScore(actor, { ...body, score: m[1] }));
  route('GET', /^\/scores\/([^/]+)$/, (s, actor, m, body, q) =>
    s.scoreState(m[1], q.get('at') ?? new Date()));

  // 发证
  route('POST', /^\/cert-cases$/, (s, actor, m, body) => s.applyCase(actor, body));
  route('GET', /^\/cert-cases\/([^/]+)$/, (s, actor, m) => s.get('certCases', m[1]));
  route('POST', /^\/cert-cases\/([^/]+)\/issue$/, (s, actor, m, body) =>
    s.issue(actor, m[1], body ?? {}));
  route('POST', /^\/cert-cases\/([^/]+)\/hold$/, (s, actor, m, body) =>
    s.holdCase(actor, m[1], body?.note, body?.at));
  route('POST', /^\/cert-cases\/([^/]+)\/reject$/, (s, actor, m, body) =>
    s.rejectCase(actor, m[1], body?.reason, body?.at));
  route('POST', /^\/certificates\/([^/]+)\/replace-evidence$/, (s, actor, m, body) =>
    s.replaceEvidence(actor, { ...body, certificate: m[1] }, body?.at));
  route('POST', /^\/certificates\/([^/]+)\/invalidate$/, (s, actor, m, body) =>
    s.invalidateCertificate(actor, m[1], body?.reason, body?.at));
  route('POST', /^\/certificates\/([^/]+)\/reissue$/, (s, actor, m, body) =>
    s.reissue(actor, { ...body, certificate: m[1] }));
  route('GET', /^\/certificates\/([^/]+)\/file$/, (s, actor, m) =>
    s.certificateFile(actor, m[1]));

  // 班次证明
  route('POST', /^\/shifts\/([^/]+)\/proofs$/, (s, actor, m, body) =>
    s.requestProof(actor, { ...body, shift: m[1] }));
  route('GET', /^\/shifts\/([^/]+)\/evaluation$/, (s, actor, m, body, q) =>
    s.evaluateShift(m[1], q.get('worker'), q.get('at') ?? new Date()));
  route('GET', /^\/contractor-view$/, (s, actor, m, body, q) =>
    s.contractorView(actor, q.get('shift')));

  // 审计
  route('GET', /^\/audit-log$/, (s) => ({ items: s.auditLog() }));

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const body = ['GET', 'HEAD'].includes(req.method) ? {} : await readBody(req);
      const actor = actorFromHeaders(service, req.headers);
      for (const candidate of routes) {
        if (candidate.method !== req.method) continue;
        const match = url.pathname.match(candidate.pattern);
        if (!match) continue;
        const result = await candidate.handler(service, actor, match, body, url.searchParams);
        return send(res, result === undefined ? 204 : 200, result ?? { ok: true });
      }
      return send(res, 404, { error: { code: 'NOT_FOUND', message: `无此接口: ${req.method} ${url.pathname}` } });
    } catch (error) {
      if (error instanceof DomainError) {
        return send(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      }
      return send(res, 500, { error: { code: 'INTERNAL', message: error.message } });
    }
  });
}

export async function startServer(options = {}) {
  const service = options.service ?? (await CredentialService.fromFile(options.dataUrl));
  const server = createApp(service);
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  await new Promise((resolve) => server.listen(port, resolve));
  return { server, port, service };
}

// 直接运行 `node src/http.js` 时启动联调服务
if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startServer();
  console.log(`credential-portability 服务已启动: http://localhost:${port}`);
}
