/**
 * 片区规则：按施行日期版本化的科目组合，以及互认范围。
 *
 * ruleVersion:
 *   { id, region, from, roles: { [role]: [subject...] },
 *     accepts: [{ issuer, subject, until }] }
 *
 * 互认在某时点有效必须同时满足：
 *   1. 当时生效版本的 accepts 包含该考点+科目，且互认截止未到；
 *   2. 当时及之前最近一条 policyNotice 没有把它关掉（allows=false）。
 * 成绩自身有效期与互认政策截止各自独立，由 evidence 模块一并检查。
 */
import { Store } from './store.js';
import { activeAt, iso, ms } from './time.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';

const EPOCH = iso(0);

export function seedRuleVersions(store, data) {
  for (const region of data.regions ?? []) {
    const accepts = region.accepts ? structuredClone(region.accepts) : [];
    store.add('ruleVersions', {
      id: store.nextId('rv'),
      region: region.id,
      from: EPOCH,
      roles: structuredClone(region.roles ?? {}),
      accepts,
      publishedAt: EPOCH,
      publishedBy: 'system-seed',
    });
  }
}

export function versionsOf(store, region) {
  return store
    .list('ruleVersions')
    .filter((version) => version.region === region)
    .sort((a, b) => ms(a.from) - ms(b.from));
}

export function versionAt(store, region, t) {
  const version = activeAt(versionsOf(store, region), t);
  if (!version) throw new NotFoundError(`片区 ${region} 尚无生效规则`);
  return version;
}

export function requirementsAt(store, region, role, t) {
  const version = versionAt(store, region, t);
  const subjects = version.roles[role];
  if (!subjects) throw new NotFoundError(`片区 ${region} 在该施行日期没有工种 ${role}`);
  return structuredClone(subjects);
}

/** 当时及之前最近一条针对 region+issuer+subject 的政策通告；没有则 null。 */
function latestNotice(store, region, issuer, subject, t) {
  const at = ms(t);
  let picked = null;
  for (const notice of store.list('policyNotices') ?? []) {
    if (
      notice.region === region &&
      notice.issuer === issuer &&
      notice.subject === subject &&
      ms(notice.from) <= at &&
      (picked === null || ms(notice.from) > ms(picked.from))
    ) {
      picked = notice;
    }
  }
  return picked;
}

/**
 * 互认是否在 t 时点有效。返回 { allowed, reason }，reason 供补报提示使用。
 */
export function acceptanceStatus(store, region, issuer, subject, t) {
  const version = versionAt(store, region, t);
  const entry = version.accepts.find(
    (item) => item.issuer === issuer && item.subject === subject,
  );
  if (!entry) {
    return { allowed: false, reason: 'NOT_IN_SCOPE', message: '当前施行规则未将该考点科目列入互认范围' };
  }
  if (ms(entry.until) <= ms(t)) {
    return { allowed: false, reason: 'ACCEPTANCE_EXPIRED', message: '互认政策截止已过', until: entry.until };
  }
  const notice = latestNotice(store, region, issuer, subject, t);
  if (notice && notice.allows === false) {
    return { allowed: false, reason: 'RECIPROCITY_STOPPED', message: '该片区已停止此项互认', notice: notice.id };
  }
  return { allowed: true };
}

/**
 * 发布新施行版本。from 必须晚于该片区当前最新版本；roles/accepts 给出整组新值，
 * 缺省字段从上一版继承，保证每个版本都是当时完整、可独立查阅的规则快照。
 */
export function publishVersion(store, actor, input) {
  const { region, from } = input;
  if (!region || !from) throw new ValidationError('region 与 from 必填');
  const versions = versionsOf(store, region);
  if (versions.length && ms(from) <= ms(versions.at(-1).from)) {
    throw new ConflictError('新版本施行时间必须晚于当前版本');
  }
  const previous = versions.at(-1);
  const row = {
    id: store.nextId('rv'),
    region,
    from: iso(from),
    roles: input.roles ? structuredClone(input.roles) : structuredClone(previous?.roles ?? {}),
    accepts: input.accepts ? structuredClone(input.accepts) : structuredClone(previous?.accepts ?? []),
    publishedAt: iso(new Date()),
    publishedBy: actor.id,
    note: input.note ?? null,
  };
  store.add('ruleVersions', row);
  store.audit(actor.id, 'rule-version.publish', row.id, { region, from: row.from });
  return row;
}

/**
 * 比较同一片区两个时点的规则差异，供「报名后规则变化，指出需要补什么」使用。
 */
export function diffVersions(store, region, fromT, toT) {
  const before = versionAt(store, region, fromT);
  const after = versionAt(store, region, toT);
  const roles = new Set([...Object.keys(before.roles), ...Object.keys(after.roles)]);
  const roleChanges = [];
  for (const role of roles) {
    const oldSet = new Set(before.roles[role] ?? []);
    const newSet = new Set(after.roles[role] ?? []);
    const added = [...newSet].filter((subject) => !oldSet.has(subject));
    const removed = [...oldSet].filter((subject) => !newSet.has(subject));
    if (added.length || removed.length || !before.roles[role] || !after.roles[role]) {
      roleChanges.push({ role, addedSubjects: added, removedSubjects: removed });
    }
  }
  const key = (item) => `${item.issuer}|${item.subject}`;
  const oldAccepts = new Map(before.accepts.map((item) => [key(item), item]));
  const newAccepts = new Map(after.accepts.map((item) => [key(item), item]));
  const acceptanceChanges = [];
  for (const [k, item] of newAccepts) {
    const old = oldAccepts.get(k);
    if (!old || ms(old.until) !== ms(item.until)) {
      acceptanceChanges.push({ ...item, change: old ? 'UNTIL_CHANGED' : 'ADDED' });
    }
  }
  for (const [k, item] of oldAccepts) {
    if (!newAccepts.has(k)) acceptanceChanges.push({ ...item, change: 'REMOVED' });
  }
  return { fromVersion: before.id, toVersion: after.id, roleChanges, acceptanceChanges };
}
