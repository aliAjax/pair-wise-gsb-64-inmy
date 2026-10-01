import { configureStore } from '@reduxjs/toolkit'
import reducer, {
  acceptRecallNotice, addShipment, backfillMaterialLots, issueMaterial, updateBatchStatus
} from './src/store/haccpSlice'
import { submitDisposalConfirmation } from './src/store/recallThunks'

// localStorage shim for module init
;(globalThis as any).localStorage = { getItem: () => null, setItem: () => {} }

function makeStore() {
  return configureStore({ reducer: { haccp: reducer } })
}

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  PASS ${name}`)
  else { failures += 1; console.log(`  FAIL ${name}`, extra ?? '') }
}

const store = makeStore()
const state = () => store.getState().haccp

console.log('== 1. 旧数据回填 ==')
store.dispatch(backfillMaterialLots({ operator: '测试' }))
check('B260929-01 已链接 RM-260927-A', state().batches.find(b => b.id === 'B260929-01')?.materialLotIds.includes('RM-260927-A') === true)
check('B260928-07 标记待补链', state().batches.find(b => b.id === 'B260928-07')?.traceStatus === '待补链')

console.log('== 2. 受理通知与冻结 ==')
store.dispatch(acceptRecallNotice({ noticeId: 'NOTICE-2026-041', materialLotId: 'RM-260927-A', reason: '原料检出李斯特菌', operator: '质量主管' }))
const recall = () => state().recalls.find(r => r.id === 'RC-NOTICE-2026-041')!
check('召回已建立 V1', recall()?.version === 1)
check('命中3批（含待补链不可排除）', recall()?.affectedBatchIds.length === 3, recall()?.affectedBatchIds)
check('待补链批次纳入待核查', recall()?.affectedBatchIds.includes('B260928-07') === true)
check('原料批次冻结', state().materialLots.find(l => l.id === 'RM-260927-A')?.status === '冻结')
check('领料单冻结', state().requisitions.filter(r => r.materialLotId === 'RM-260927-A').every(r => r.status === '冻结'))
check('命中批次隔离', state().batches.find(b => b.id === 'B260929-02')?.status === '隔离中')
check('已放行批次也冻结', state().batches.find(b => b.id === 'B260928-07')?.status === '隔离中')
check('自动生成带召回号的偏差', state().deviations.filter(d => d.recallId === 'RC-NOTICE-2026-041').length === 3)
check('召回状态为待核查（去向未补齐）', recall()?.status === '待核查')
const auditRecall = state().audit.filter(a => a.recallId === 'RC-NOTICE-2026-041')
check('审计带召回号', auditRecall.length >= 1)

console.log('== 3. 幂等：同一通知只受理一次 ==')
store.dispatch(acceptRecallNotice({ noticeId: 'NOTICE-2026-041', materialLotId: 'RM-260927-A', reason: '重复提交', operator: '质量主管' }))
check('仍只有1起召回', state().recalls.length === 1)
check('版本未被重复操作改变', recall()?.version === 1)

console.log('== 4. 冻结放行与领用 ==')
store.dispatch(updateBatchStatus({ id: 'B260929-02', status: '可放行' }))
check('召回冻结批次禁止转可放行', state().batches.find(b => b.id === 'B260929-02')?.status === '隔离中')
const reqBefore = state().requisitions.length
store.dispatch(issueMaterial({ materialLotId: 'RM-260927-A', batchId: 'B260928-07', quantity: 100, operator: '仓库' }))
check('冻结批次禁止领用', state().requisitions.length === reqBefore)
check('拦截写入审计', state().audit.some(a => a.action === '领用被冻结拦截' && a.recallId === 'RC-NOTICE-2026-041'))
store.dispatch(issueMaterial({ materialLotId: 'RM-260926-C', batchId: 'B260928-07', quantity: 50, operator: '仓库' }))
check('未冻结批次可正常领用并补链', state().batches.find(b => b.id === 'B260928-07')?.traceStatus === '已链接')

console.log('== 5. 并发处置确认：后提交者看到范围变化 ==')
// 班长甲基于 V1 提交成功
const r1 = store.dispatch(submitDisposalConfirmation({ recallId: recall().id, requestId: 'REQ-A', batchIds: ['B260929-01'], leader: '一班班长 王磊', decision: '报废', note: '甲的确认', baseVersion: 1 }))
check('班长甲提交应用', r1 === 'applied', r1)
check('召回版本升至 V2', recall()?.version === 2)
check('B260929-01 已报废', state().batches.find(b => b.id === 'B260929-01')?.status === '已报废')
// 班长乙仍基于 V1 提交（同时打开工单）
const r2 = store.dispatch(submitDisposalConfirmation({ recallId: recall().id, requestId: 'REQ-B', batchIds: ['B260929-02', 'B260928-07'], leader: '二班班长 李强', decision: '返工', note: '乙的确认', baseVersion: 1 }))
check('班长乙提交被判冲突', r2 === 'conflict', r2)
const stale = recall().confirmations.find(c => c.id === 'REQ-B')
check('乙的记录保留为范围已变更', stale?.status === '范围已变更' && stale.note === '乙的确认')
check('乙的批次未被应用', state().batches.find(b => b.id === 'B260929-02')?.status === '隔离中')
check('冲突写入审计', state().audit.some(a => a.action === '处置确认范围冲突'))
// 乙按新版本重新确认
const r3 = store.dispatch(submitDisposalConfirmation({ recallId: recall().id, requestId: 'REQ-B2', batchIds: ['B260929-02', 'B260928-07'], leader: '二班班长 李强', decision: '返工', note: '乙重新确认', baseVersion: 2 }))
check('乙重新确认应用', r3 === 'applied', r3)
check('确认记录不重复', recall().confirmations.filter(c => c.status === '已确认').length === 2)

console.log('== 6. 写入失败恢复与幂等重试 ==')
store.dispatch(acceptRecallNotice({ noticeId: 'NOTICE-2026-042', materialLotId: 'RM-260925-B', reason: '菌种活性不足', operator: '质量主管' }))
const recall2 = () => state().recalls.find(r => r.id === 'RC-NOTICE-2026-042')!
const scope2 = recall2().affectedBatchIds
check('第二起召回命中 B260929-02', scope2.includes('B260929-02'), scope2)
const fail1 = store.dispatch(submitDisposalConfirmation({ recallId: recall2().id, requestId: 'REQ-C', batchIds: scope2, leader: '一班班长 王磊', decision: '报废', note: '', baseVersion: 1, simulateFailure: true }))
check('模拟写入中断', fail1 === 'failed', fail1)
check('未完成批次恢复待确认', recall2().pendingWrite?.phase === '已恢复')
check('中断后无确认记录生成', recall2().confirmations.filter(c => c.status === '已确认').length === 0)
const batchStatusAfterFail = state().batches.find(b => b.id === recall2().pendingWrite!.remainingBatchIds[0])?.status
check('未完成批次未被处置', batchStatusAfterFail !== '已报废', batchStatusAfterFail)
// 重试：相同请求号
const fail2 = store.dispatch(submitDisposalConfirmation({ recallId: recall2().id, requestId: 'REQ-C', batchIds: scope2, leader: '一班班长 王磊', decision: '报废', note: '', baseVersion: 1 }))
check('断点续写成功', fail2 === 'applied', fail2)
check('确认记录只生成一次', recall2().confirmations.filter(c => c.id === 'REQ-C' && c.status === '已确认').length === 1)
// 重复提交同一请求号
const dup = store.dispatch(submitDisposalConfirmation({ recallId: recall2().id, requestId: 'REQ-C', batchIds: scope2, leader: '一班班长 王磊', decision: '报废', note: '', baseVersion: 1 }))
check('重复请求号不重复生成', dup === 'duplicate' || dup === 'conflict', dup)
check('确认记录仍只有一条', recall2().confirmations.filter(c => c.id === 'REQ-C').length === 1)

console.log('== 7. 补齐去向与召回完成 ==')
// 第一起召回：B260929-01 报废已确认；B260929-02 返工已确认；B260928-07 返工已确认 → 全部核清
check('第一起召回已完成', recall()?.status === '已完成', recall()?.status)
// 第二起召回：B260929-02 报废确认 → 全部确认即完成
check('第二起召回已完成', recall2()?.status === '已完成', recall2()?.status)

console.log('== 8. 去向登记驱动版本与状态 ==')
store.dispatch(acceptRecallNotice({ noticeId: 'NOTICE-2026-043', materialLotId: 'RM-260926-C', reason: '标签错误', operator: '质量主管' }))
const recall3 = () => state().recalls.find(r => r.id === 'RC-NOTICE-2026-043')!
const v0 = recall3().version
store.dispatch(addShipment({ recallId: recall3().id, batchId: 'B260928-07', destination: '华东仓', packagingShift: '09-30 08:00-10:00', quantity: 100, operator: '仓库' }))
check('登记去向提升召回版本', recall3().version === v0 + 1, `${v0} -> ${recall3().version}`)
// B260928-07 已发运 5100+100 >= 5100 → 去向核清，但未确认 → 处置中
check('去向核清后转入处置中', recall3().status === '处置中', recall3().status)

console.log('== 9. 多批部分写入中断与续写 ==')
const store2 = makeStore()
const s2 = () => store2.getState().haccp
store2.dispatch(backfillMaterialLots({ operator: '测试' }))
store2.dispatch(acceptRecallNotice({ noticeId: 'NOTICE-2026-044', materialLotId: 'RM-260927-A', reason: '多批中断演练', operator: '质量主管' }))
const recall4 = () => s2().recalls.find(r => r.id === 'RC-NOTICE-2026-044')!
const scope4 = recall4().affectedBatchIds
check('演练召回命中3批', scope4.length === 3, scope4)
const part1 = store2.dispatch(submitDisposalConfirmation({ recallId: recall4().id, requestId: 'REQ-D', batchIds: scope4, leader: '班长', decision: '报废', note: '', baseVersion: 1, simulateFailure: true }))
check('多批写入中断', part1 === 'failed', part1)
const firstWritten = scope4[0]
check('首批已写入（已报废）', s2().batches.find(b => b.id === firstWritten)?.status === '已报废')
check('其余批次恢复待确认', recall4().pendingWrite?.remainingBatchIds.length === 2, recall4().pendingWrite)
const part2 = store2.dispatch(submitDisposalConfirmation({ recallId: recall4().id, requestId: 'REQ-D', batchIds: scope4, leader: '班长', decision: '报废', note: '', baseVersion: 1 }))
check('续写完成', part2 === 'applied', part2)
check('全部批次已报废', scope4.every(id => s2().batches.find(b => b.id === id)?.status === '已报废'))
check('只生成一条确认记录覆盖3批', recall4().confirmations.filter(c => c.status === '已确认').length === 1 && recall4().confirmations[0].batchIds.length === 3)
const writesForFirst = s2().audit.filter(a => a.entity === firstWritten && a.action === '召回处置写入').length
check('首批未重复写入', writesForFirst === 1, writesForFirst)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
