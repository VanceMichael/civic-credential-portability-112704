/**
 * 角色与权限。
 *
 * actor:
 *   { id, type, centreId?, region?, contractorId?, permissions?: string[] }
 *
 *  - centre-operator：仅可维护本考点考场、录入具备出席资格者的成绩
 *  - reviewer：复核员，唯一可在事后提出成绩更正
 *  - issuer：发证方，按片区处理签发/暂缓/拒签
 *  - contractor：仅能看本承包班组的排程与缺证原因类别，看不到分数与他人信息
 *  - regulator：授权核查方，可查阅含已不成立证照在内的留档记录
 */
import { PermissionError } from './errors.js';

export function defineActor(store, input) {
  const actor = {
    id: input.id,
    type: input.type,
    centreId: input.centreId ?? null,
    region: input.region ?? null,
    contractorId: input.contractorId ?? null,
    permissions: input.permissions ?? [],
  };
  const existing = store.find('actors', actor.id);
  if (existing) Object.assign(existing, actor);
  else store.add('actors', actor);
  return actor;
}

export function assertType(actor, ...types) {
  if (!actor || !types.includes(actor.type)) {
    throw new PermissionError(`需要角色 ${types.join(' 或 ')}，当前为 ${actor?.type ?? '匿名'}`);
  }
}

export function assertCentreOwnership(actor, examOrCentre, store) {
  assertType(actor, 'centre-operator');
  const centreId = examOrCentre.centre ?? examOrCentre.id;
  if (actor.centreId !== centreId) {
    throw new PermissionError('考点只能维护自己的考场与成绩');
  }
  const centre = store.find('centres', centreId);
  if (!centre) throw new PermissionError('考点不存在');
  return centre;
}

export function assertRegion(actor, region) {
  assertType(actor, 'issuer');
  if (actor.region && actor.region !== region) {
    throw new PermissionError('发证方只能处理本片区材料');
  }
}

export function assertContractor(actor, contractorId) {
  assertType(actor, 'contractor');
  if (actor.contractorId !== contractorId) {
    throw new PermissionError('只能查询本承包班组的资料');
  }
}
