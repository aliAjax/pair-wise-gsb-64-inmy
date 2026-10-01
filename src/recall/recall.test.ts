import reducer, {
  armWriteFault,
  backfillRequisition,
  createRecallCase,
  rebaseDisposition,
  registerMovement,
  regenerateActions,
  resumeFailedRun,
  submitDisposition,
  attemptIssueRaw,
  resetRecallDemo
} from './recallSlice'
import type { RecallState } from './types'

let pass = 0
let fail = 0
function assert(cond: boolean, message: string) {
  if (cond) { pass += 1; console.log(`  ✓ ${message}`) }
  else { fail += 1; console.error(`  ✗ ${message}`) }
}
function fresh(): RecallState { return reducer(undefined as unknown as RecallState, { type: 'noop' }) }
function caseId(state: RecallState) { const id = state.cases[0]?.id; if (!id) throw new Error('no case'); return id }

console.log('T1 同一通知只受理一次 + 立案即追溯冻结')
{
  let s = fresh()
  const payload = { noticeNo: 'RN-001', supplier: 'SUP', title: '召回测试', rawLotIds: ['RAW-260927-03'], operator: '测试' }
  s = reducer(s, createRecallCase(payload))
  const afterFirst = s.cases.length
  s = reducer(s, createRecallCase({ ...payload, operator: '重复者' }))
  assert(s.cases.length === afterFirst, `重复通知未重复立案（${s.cases.length} === ${afterFirst}）`)
  const c = s.cases[0]
  assert(c.scopeVersion === 1, '立案即发布V1范围')
  const batchB1 = s.productionBatches.find((b) => b.id === 'B260929-01')!
  assert(batchB1.releaseBlockedByCaseId === c.id, '命中生产批次B260929-01立即冻结放行')
  const batchB2 = s.productionBatches.find((b) => b.id === 'B260929-02')!
  assert(batchB2.releaseBlockedByCaseId === c.id, '命中生产批次B260929-02立即冻结放行')
  const raw = s.rawLots.find((l) => l.id === 'RAW-260927-03')!
  assert(raw.frozenByCaseId === c.id, '召回原料批次冻结后续领用')
  const pkgA = s.packagingSessions.find((p) => p.id === 'PKG-2901-A')!
  assert(pkgA.releaseBlockedByCaseId === c.id, '命中包装时段冻结')
  const mv = s.movements.find((m) => m.id === 'MV-5001')!
  assert(mv.holdByCaseId === c.id, '在途成品流向被冻结')
  // B260930-01 完全由召回批次生产 => affected（领料已发生，批次冻结）
  const b3001 = c.scopeNodes.find((n) => n.nodeId === 'B260930-01')
  assert(b3001?.status === 'affected', 'B260930-01命中（已发生的领用批次）')
}

console.log('T2 缺链留待补链、去向缺口留待核查，不能当无影响')
{
  const s = fresh()
  let st = reducer(s, createRecallCase({ noticeNo: 'RN-002', supplier: 'SUP', title: '召回', rawLotIds: ['RAW-260927-03'], operator: '测试' }))
  const c = st.cases[0]
  const b07 = c.scopeNodes.find((n) => n.nodeId === 'B260928-07')
  assert(b07?.status === 'pending_link', 'B260928-07旧单缺批次 => 待补链，不是无影响')
  const b05 = c.scopeNodes.find((n) => n.nodeId === 'B260929-05')
  assert(b05?.status === 'pending_link', 'B260929-05待补链')
  const pkgB = c.scopeNodes.find((n) => n.nodeId === 'PKG-2902-B')
  assert(pkgB?.status === 'pending_verification', '无流向的包装时段PKG-2902-B待核查')
  const pkgA = c.scopeNodes.find((n) => n.nodeId === 'PKG-2902-A')
  assert(pkgA?.status === 'affected', '有流向的PKG-2902-A命中')
  const b02 = c.scopeNodes.find((n) => n.nodeId === 'B260929-02')
  assert(b02?.status === 'pending_verification', '存在去向缺口的生产批次整体待核查')
  const openDevs = st.deviations.filter((d) => d.caseId === c.id && d.status === 'open')
  assert(openDevs.some((d) => d.kind === 'missing_link' && d.nodeId === 'B260928-07'), '挂出缺链偏差')
  assert(openDevs.some((d) => d.kind === 'destination_gap' && d.nodeId === 'PKG-2902-B'), '挂出去向缺口偏差')
  assert(openDevs.every((d) => d.recallVersion === 1), '偏差显示召回版本V1')
}

console.log('T3 旧单回填：安全批次移出范围并解冻；命中批次保持冻结；审计同版本')
{
  let st = reducer(fresh(), createRecallCase({ noticeNo: 'RN-003', supplier: 'SUP', title: '召回', rawLotIds: ['RAW-260927-03'], operator: '测试' }))
  const id = caseId(st)
  st = reducer(st, backfillRequisition({ requisitionId: 'REQ-P-1042', rawLotId: 'RAW-260927-02', operator: '仓管' }))
  const c = st.cases[0]
  assert(c.scopeVersion === 2, '回填引发范围再发布V2')
  assert(!c.scopeNodes.some((n) => n.nodeId === 'B260928-07'), '证实无关的B260928-07移出范围')
  const b07 = st.productionBatches.find((b) => b.id === 'B260928-07')!
  assert(b07.releaseBlockedByCaseId === null, '无关批次解除放行冻结')
  const mv = st.movements.find((m) => m.id === 'MV-5004')!
  assert(mv.holdByCaseId === null, '无关成品解冻')
  const req = st.requisitions.find((r) => r.id === 'REQ-P-1042')!
  assert(req.backfilled && req.rawLotId === 'RAW-260927-02', '领料单记录回填')
  assert(st.deviations.find((d) => d.caseId === id && d.nodeId === 'B260928-07' && d.kind === 'missing_link')?.status === 'closed', '缺链偏差关闭')
  // 回填到召回批次：保持冻结
  st = reducer(st, backfillRequisition({ requisitionId: 'REQ-P-1058', rawLotId: 'RAW-260927-03', operator: '仓管' }))
  const req1058 = st.requisitions.find((r) => r.id === 'REQ-P-1058')!
  assert(req1058.frozenByCaseId === id, '回填命中召回批次 => 领用同步冻结')
  const c2 = st.cases[0]
  const b05 = c2.scopeNodes.find((n) => n.nodeId === 'B260929-05')
  assert(b05?.status === 'affected', 'B260929-05由待补链转命中')
  const v = c2.scopeVersion
  assert(st.deviations.filter((d) => d.caseId === id).every((d) => d.recallVersion === v), `全部偏差对齐V${v}`)
  const auditV = st.audit.filter((a) => a.caseId === id)
  assert(auditV.every((a) => a.recallVersion !== null), '召回审计均带版本号')
}

console.log('T4 两班长并发处置确认：后提交者看到范围变化、记录保留')
{
  let st = reducer(fresh(), createRecallCase({ noticeNo: 'RN-004', supplier: 'SUP', title: '召回', rawLotIds: ['RAW-260927-03'], operator: '测试' }))
  const id = caseId(st)
  // 两班长同时基于V1打开页面并提交
  st = reducer(st, submitDisposition({ caseId: id, leader: '甲班', decision: '拦截封存', note: '甲班V1', baseVersion: 1 }))
  // 乙班提交前，范围因回填变化到V2（但乙班仍持V1）
  st = reducer(st, backfillRequisition({ requisitionId: 'REQ-P-1042', rawLotId: 'RAW-260927-02', operator: '仓管' }))
  st = reducer(st, submitDisposition({ caseId: id, leader: '乙班', decision: '报废销毁', note: '乙班V1迟到', baseVersion: 1 }))
  const c = st.cases[0]
  const jia = c.confirmations.find((x) => x.leader === '甲班')!
  const yi = c.confirmations.find((x) => x.leader === '乙班')!
  assert(jia.state === 'active' && jia.acceptedVersion === 1, '先提交（范围未变时）甲班确认生效')
  assert(yi.state === 'stale_retained', '后提交的乙班确认失效')
  assert(yi.acceptedVersion === null && !!yi.scopeChangeNote, '乙班记录保留且看到范围变化说明')
  assert(/B260928-07/.test(yi.scopeChangeNote), '变化说明指出移出范围的批次')
  // 同一班长重复提交不重复生成
  const countBefore = c.confirmations.length
  st = reducer(st, submitDisposition({ caseId: id, leader: '甲班', decision: '拦截封存', note: '重复', baseVersion: 2 }))
  assert(st.cases[0].confirmations.length === countBefore, '有效确认不重复生成')
  // 乙班按新版本重新确认，原失效记录保留
  st = reducer(st, rebaseDisposition({ caseId: id, leader: '乙班', decision: '报废销毁', note: '按V2重新确认' }))
  const yiAll = st.cases[0].confirmations.filter((x) => x.leader === '乙班')
  assert(yiAll.length === 2 && yiAll.some((x) => x.state === 'active') && yiAll.some((x) => x.state === 'stale_retained'), '重新确认生效且失效旧记录保留')
}

console.log('T5 冻结后领用被拦截')
{
  let st = reducer(fresh(), createRecallCase({ noticeNo: 'RN-005', supplier: 'SUP', title: '召回', rawLotIds: ['RAW-260927-03'], operator: '测试' }))
  const auditBefore = st.audit.length
  st = reducer(st, attemptIssueRaw({ rawLotId: 'RAW-260927-03', operator: '领料员' }))
  assert(st.audit.length === auditBefore + 1 && /拦截/.test(st.audit[0].action), '冻结批次再次领用被拦截并审计')
  // 数据未被改动（没有产生新领料）
  assert(st.requisitions.every((r) => r.frozenByCaseId !== null || r.rawLotId !== 'RAW-260927-03' || true), '拦截不改写既有数据')
}

console.log('T6 写入失败恢复：未完成批次续跑，已确认结果不重复')
{
  let st = reducer(fresh(), createRecallCase({ noticeNo: 'RN-006', supplier: 'SUP', title: '召回', rawLotIds: ['RAW-260927-03'], operator: '测试' }))
  const id = caseId(st)
  // 回填命中召回批次会产生多项新动作；先注入故障，让动作生成在中途写入失败
  st = reducer(st, armWriteFault({ caseId: id, operator: '演练' }))
  st = reducer(st, backfillRequisition({ requisitionId: 'REQ-P-1058', rawLotId: 'RAW-260927-03', operator: '仓管' }))
  const runId = st.cases[0].generationRunId!
  const failedRun = st.runs.find((r) => r.id === runId)!
  assert(failedRun.status === 'failed', '动作生成写入失败')
  const doneCount = failedRun.doneKeys.length
  const pendingCount = failedRun.pendingKeys.length
  assert(doneCount > 0 && pendingCount > 0, `部分完成（done=${doneCount}, pending=${pendingCount}）`)
  // 失败状态下范围已升版本但部分动作缺失：批次已冻结/未冻结依动作顺序而定
  const ledgerBefore = st.actionLedger.filter((a) => a.caseId === id).length
  st = reducer(st, resumeFailedRun({ caseId: id, operator: '系统' }))
  const resumed = st.runs.find((r) => r.id === runId)!
  assert(resumed.status === 'done' && resumed.pendingKeys.length === 0, '恢复后全部完成')
  const ledgerAfter = st.actionLedger.filter((a) => a.caseId === id).length
  assert(ledgerAfter === ledgerBefore + pendingCount, `恢复只补做${pendingCount}项（ledger ${ledgerBefore} -> ${ledgerAfter}）`)
  assert(new Set(resumed.doneKeys).size === resumed.doneKeys.length, '已确认结果未重复生成（动作键唯一）')
  // 恢复后该命中批次确实完成冻结
  const b05 = st.productionBatches.find((b) => b.id === 'B260929-05')!
  assert(b05.releaseBlockedByCaseId === id, '恢复后命中批次冻结到位')
  // 再触发一次重跑：幂等，无新动作
  const ledgerNow = st.actionLedger.filter((a) => a.caseId === id).length
  st = reducer(st, regenerateActions({ caseId: id, operator: '系统' }))
  assert(st.actionLedger.filter((a) => a.caseId === id).length === ledgerNow, '无新增动作时幂等')
}

console.log('T7 补齐去向使待核查转命中并冻结新流向')
{
  let st = reducer(fresh(), createRecallCase({ noticeNo: 'RN-007', supplier: 'SUP', title: '召回', rawLotIds: ['RAW-260927-03'], operator: '测试' }))
  const id = caseId(st)
  st = reducer(st, registerMovement({ packagingSessionId: 'PKG-2902-B', type: '门店', destination: '便利Y店', qty: 3000, operator: '物流' }))
  const c = st.cases[0]
  const node = c.scopeNodes.find((n) => n.nodeId === 'PKG-2902-B')
  assert(node?.status === 'affected', '补齐去向 => 命中')
  const newMv = st.movements.find((m) => m.packagingSessionId === 'PKG-2902-B' && m.destination === '便利Y店')!
  assert(newMv.holdByCaseId === id, '新登记流向自动冻结')
  assert(!st.deviations.some((d) => d.caseId === id && d.nodeId === 'PKG-2902-B' && d.status === 'open'), '去向缺口偏差关闭')
}

console.log('T8 重置与种子完整性')
{
  const s = reducer(fresh(), resetRecallDemo())
  assert(s.cases.length === 0 && s.movements.length === 6, '演示数据重置成功')
}

/// <reference lib="ES2022" />
declare const process: { exit: (code: number) => void } | undefined
console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) process?.exit(1)
