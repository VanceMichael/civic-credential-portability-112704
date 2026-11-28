/**
 * 应用服务门面：装载联调资料、接线跨模块事件，对外暴露统一 API。
 * HTTP 层与测试都只依赖本模块，不直接操作 store。
 */
import { readFile } from 'node:fs/promises';
import { seedStore, Store } from './store.js';
import { seedRuleVersions, publishVersion, versionAt, versionsOf, acceptanceStatus, diffVersions } from './policy.js';
import { receiveScore, reviseScore, assessRequirements, evaluateEvidence, scoreState, usability } from './evidence.js';
import {
  createExam, reserveSeat, lockExam, checkIn, cancelClaim,
  rejudgeWaitlist, checkEligibility, enterScore,
} from './exams.js';
import {
  applyCase, issue, holdCase, rejectCase, suspendDependents, replaceEvidence,
  invalidate, reissue, certificateFile,
} from './certificates.js';
import {
  requestProof, evaluateShift, applyEvidenceEvent, contractorView, GAP_REASONS,
} from './shifts.js';
import { defineActor } from './access.js';
import { iso, ms } from './time.js';

const DEFAULT_DATA_URL = new URL('../data/records.json', import.meta.url);

export class CredentialService {
  constructor(store = new Store()) {
    this.store = store;
  }

  static async fromFile(fileUrl = DEFAULT_DATA_URL) {
    const data = JSON.parse(await readFile(fileUrl, 'utf8'));
    return CredentialService.fromData(data);
  }

  static fromData(data) {
    const service = new CredentialService();
    const store = service.store;
    seedStore(store, data);
    seedRuleVersions(store, data);

    // 互认通告作为独立的政策事件留痕，规则版本的 accepts 与它共同决定互认有效性。
    for (const notice of data.policyNotices ?? []) {
      store.add('policyNotices', structuredClone(notice));
    }

    // 资料中的报考单默认按时间与座位数推导预留/候补状态（seedStore 先置 reserved）。
    service._reconcileSeedClaims();

    // 资料中的复核记录为历史事件：先回放其对证照状态的影响，
    // 再按回放后的证据状态重算历史班次证明的覆盖与缺口。
    for (const revision of [...(data.scoreRevisions ?? [])].sort((a, b) => ms(a.at) - ms(b.at))) {
      service._replayRevision(revision);
    }
    for (const letter of store.list('proofLetters')) {
      const evaluation = evaluateShift(store, letter.shift, letter.worker, letter.recordedAt);
      letter.status = evaluation.confirmed ? 'confirmed' : 'denied';
      letter.gaps = evaluation.gaps;
    }
    return service;
  }

  _reconcileSeedClaims() {
    for (const exam of this.store.list('exams')) {
      const claims = this.store
        .list('examClaims')
        .filter((claim) => claim.exam === exam.id)
        .sort((a, b) => ms(a.at) - ms(b.at));
      let occupied = 0;
      for (const claim of claims) {
        if (occupied < exam.seats) {
          claim.status = 'reserved';
          occupied += 1;
        } else {
          claim.status = 'waitlisted';
        }
      }
    }
  }

  _replayRevision(revision) {
    const score = this.store.find('scores', revision.score);
    if (!score) return;
    const cause = revision.revoked ? 'SCORE_REVOKED'
      : revision.passed ? 'SCORE_REVISED_PASS'
        : 'SCORE_OVERTURNED';
    if (revision.revoked || revision.passed === false) {
      const suspended = suspendDependents(this.store, score.id, cause, revision.at);
      applyEvidenceEvent(
        this.store,
        { workers: [score.worker], cause, score: score.id, certificates: suspended.map((item) => item.id) },
        revision.at,
      );
    }
  }

  // ---------- 参与者 ----------
  defineActor(input) {
    return defineActor(this.store, input);
  }

  // ---------- 规则 ----------
  publishRuleVersion(actor, input) {
    return publishVersion(this.store, actor, input);
  }

  ruleVersion(region, t) {
    return versionAt(this.store, region, t);
  }

  ruleVersions(region) {
    return versionsOf(this.store, region);
  }

  acceptance(region, issuer, subject, t) {
    return acceptanceStatus(this.store, region, issuer, subject, t);
  }

  ruleDiff(region, fromT, toT) {
    return diffVersions(this.store, region, fromT, toT);
  }

  // ---------- 证据 ----------
  receiveScore(actor, input) {
    return receiveScore(this.store, actor, input);
  }

  reviseScore(actor, input) {
    const revision = reviseScore(this.store, actor, input);
    const score = this.store.find('scores', input.score);
    if (input.revoked === true || input.passed === false) {
      const cause = input.revoked === true ? 'SCORE_REVOKED' : 'SCORE_OVERTURNED';
      const suspended = suspendDependents(this.store, score.id, cause, revision.at);
      const affected = applyEvidenceEvent(
        this.store,
        { workers: [score.worker], cause, score: score.id, certificates: suspended.map((item) => item.id) },
        revision.at,
      );
      return { revision, suspended, affected };
    }
    return { revision, suspended: [], affected: [] };
  }

  assessEvidence(input) {
    return assessRequirements(this.store, input);
  }

  evaluateEvidence(input) {
    return evaluateEvidence(this.store, input);
  }

  scoreState(scoreId, t = new Date()) {
    const score = this.store.find('scores', scoreId);
    return score ? scoreState(this.store, score, t) : null;
  }

  usability(region, role, scoreId, t) {
    const score = this.store.find('scores', scoreId);
    return usability(this.store, region, role, score, t);
  }

  // ---------- 考务 ----------
  createExam(actor, input) {
    return createExam(this.store, actor, input);
  }

  reserveSeat(actor, input) {
    return reserveSeat(this.store, actor, input);
  }

  lockExam(actor, examId, at) {
    return lockExam(this.store, actor, examId, at);
  }

  checkIn(actor, input) {
    return checkIn(this.store, actor, input);
  }

  cancelClaim(actor, claimId, at) {
    return cancelClaim(this.store, actor, claimId, at);
  }

  rejudgeWaitlist(examId, t) {
    return rejudgeWaitlist(this.store, examId, t);
  }

  eligibility(examId, claimId, t) {
    const exam = this.store.find('exams', examId);
    const claim = this.store.find('examClaims', claimId);
    return checkEligibility(this.store, exam, claim, t);
  }

  enterScore(actor, input) {
    return enterScore(this.store, actor, input);
  }

  // ---------- 发证 ----------
  applyCase(actor, input) {
    return applyCase(this.store, actor, input);
  }

  issue(actor, caseId, input) {
    return issue(this.store, actor, caseId, input);
  }

  holdCase(actor, caseId, note, at) {
    return holdCase(this.store, actor, caseId, note, at);
  }

  rejectCase(actor, caseId, reason, at) {
    return rejectCase(this.store, actor, caseId, reason, at);
  }

  replaceEvidence(actor, input, at) {
    return replaceEvidence(this.store, actor, input, at);
  }

  invalidateCertificate(actor, certificateId, reason, at) {
    const certificate = invalidate(this.store, actor, certificateId, reason, at);
    applyEvidenceEvent(
      this.store,
      { workers: [certificate.worker], cause: 'CERTIFICATE_INVALID', certificate: certificate.id },
      at,
    );
    return certificate;
  }

  reissue(actor, input) {
    return reissue(this.store, actor, input);
  }

  certificateFile(actor, certificateId) {
    return certificateFile(this.store, actor, certificateId);
  }

  // ---------- 班次证明 ----------
  requestProof(actor, input) {
    return requestProof(this.store, actor, input);
  }

  evaluateShift(shiftId, worker, t) {
    return evaluateShift(this.store, shiftId, worker, t);
  }

  contractorView(actor, shiftId) {
    return contractorView(this.store, actor, shiftId);
  }

  // ---------- 只读查询 ----------
  get(collection, id) {
    return this.store.find(collection, id);
  }

  list(collection) {
    return this.store.list(collection);
  }

  auditLog() {
    return this.store.list('auditLog');
  }
}

export { GAP_REASONS, iso };
