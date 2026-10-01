import { createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit'
import { buildRecallSeed } from './seed'
import {
  alignDeviationVersions,
  appliedActionKeys,
  computeScope,
  makeSnapshot,
  planActions,
  resumeActionGeneration,
  runActionGeneration,
  scopeChanged
} from './engine'
import type {
  DispositionConfirmation,
  MovementType,
  RecallAuditEntry,
  RecallCase,
  RecallState
} from './types'

const STORAGE_KEY = 'gsb64:recall-trace'

function initialState(): RecallState {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (raw) {
      const parsed = JSON.parse(raw) as RecallState
      if (parsed && Array.isArray(parsed.cases)) {
        // 故障注入只在当前会话有效：刷新后不允许遗留半故障状态
        parsed.faultInjection = false
        return parsed
      }
    }
  } catch {
    // 持久化不可用时回落到演练种子数据
  }
  return buildRecallSeed()
}

function audit(state: RecallState, caseId: string | null, action: string, operator: string, detail: string, recallVersion: number | null) {
  const entry: RecallAuditEntry = { id: nanoid(), caseId, action, operator, detail, createdAt: new Date().toISOString(), recallVersion }
  state.audit.unshift(entry)
}

function findCase(state: RecallState, caseId: string): RecallCase {
  const recallCase = state.cases.find((item) => item.id === caseId)
  if (!recallCase) throw new Error(`召回案不存在：${caseId}`)
  return recallCase
}

/** 重算范围；仅在确有变化时升版本并发布快照，返回是否发生变化 */
function recomputeScope(state: RecallState, recallCase: RecallCase, note: string, operator: string): boolean {
  const previous = recallCase.scopeNodes
  const next = computeScope(state, recallCase.recalledLots).map((node) => ({ ...node, scopeVersion: recallCase.scopeVersion + 1 }))
  if (!scopeChanged(previous, next)) return false
  recallCase.scopeVersion += 1
  recallCase.scopeNodes = next
  recallCase.snapshots.unshift(makeSnapshot(recallCase.scopeVersion, next, note))
  state.deviations = alignDeviationVersions(state, recallCase.id, recallCase.scopeVersion)
  audit(state, recallCase.id, '召回范围变更', operator, `范围发布V${recallCase.scopeVersion}：${note}`, recallCase.scopeVersion)
  return true
}

/**
 * 依据当前范围生成（或按需重跑）处置动作：动作键幂等，
 * 已确认入账的结果不会重复生成；返回执行结果供界面提示。
 */
function generateActions(state: RecallState, recallCase: RecallCase, operator: string, opts: { fault: boolean }) {
  const pending = planActions(state, recallCase).filter((action) => !appliedActionKeys(state, recallCase.id).has(action.actionKey))
  if (pending.length === 0) {
    audit(state, recallCase.id, '动作生成', operator, '所有处置动作均已确认入账，无重复生成', recallCase.scopeVersion)
    return null
  }
  state.faultInjection = opts.fault || state.faultInjection
  const result = runActionGeneration(state, recallCase, null, false)
  commitRunResult(state, result.state)
  const run = state.runs[0]
  if (run.status === 'failed') {
    audit(state, recallCase.id, '动作写入失败', operator, `${run.failure}；${run.doneKeys.length}项已确认，${run.pendingKeys.length}项待恢复`, recallCase.scopeVersion)
  } else {
    audit(state, recallCase.id, '召回处置动作', operator, `生成${run.doneKeys.length}项冻结/偏差动作（运行${run.id}）`, recallCase.scopeVersion)
  }
  return run
}

/** 用纯函数引擎返回的新状态覆盖实体集合与账本（保留故障标志以外的全部结果） */
function commitRunResult(state: RecallState, result: RecallState) {
  state.rawLots = result.rawLots
  state.requisitions = result.requisitions
  state.productionBatches = result.productionBatches
  state.packagingSessions = result.packagingSessions
  state.movements = result.movements
  state.deviations = result.deviations
  state.actionLedger = result.actionLedger
  state.runs = result.runs
  state.seq = result.seq
}

interface CreateCasePayload {
  noticeNo: string
  supplier: string
  title: string
  rawLotIds: string[]
  operator: string
}

interface BackfillPayload {
  requisitionId: string
  rawLotId: string
  operator: string
}

interface RegisterMovementPayload {
  packagingSessionId: string
  type: MovementType
  destination: string
  qty: number
  operator: string
}

interface SubmitDispositionPayload {
  caseId: string
  leader: string
  decision: DispositionConfirmation['decision']
  note: string
  /** 两班长并发：提交时各自携带的基准版本 */
  baseVersion: number
}

const slice = createSlice({
  name: 'recall',
  initialState,
  reducers: {
    /** 同一供应商通知只受理一次：通知号唯一 */
    createRecallCase(state, action: PayloadAction<CreateCasePayload>) {
      const { noticeNo, supplier, title, rawLotIds, operator } = action.payload
      if (state.cases.some((item) => item.noticeNo === noticeNo)) {
        audit(state, null, '通知受理拦截', operator, `供应商召回通知 ${noticeNo} 已受理，同一通知不重复立案`, null)
        return
      }
      const uniqueLots = Array.from(new Set(rawLotIds))
      const id = `RC-${noticeNo.replace(/[^A-Za-z0-9]/g, '').slice(-8)}-${state.cases.length + 1}`
      const recallCase: RecallCase = {
        id,
        noticeNo,
        supplier,
        title,
        receivedAt: new Date().toISOString(),
        status: 'open',
        recalledLots: uniqueLots.map((rawLotId) => ({ rawLotId, reason: title })),
        scopeVersion: 0,
        scopeNodes: [],
        snapshots: [],
        confirmations: [],
        generationRunId: null
      }
      state.cases.unshift(recallCase)
      audit(state, id, '受理供应商召回通知', operator, `通知${noticeNo}立案，召回原料批次：${uniqueLots.join('、')}`, 0)

      // 立即追溯范围并发布V1；命中批次立即冻结放行与后续领用
      recomputeScope(state, recallCase, '按领料单初始追溯：原料批次→生产批次→包装时段→成品去向', operator)
      const run = generateActions(state, recallCase, operator, { fault: false })
      recallCase.generationRunId = run ? run.id : recallCase.generationRunId
    },

    /** 旧数据按纸质领料单回填原料批次；缺失的保留待补链 */
    backfillRequisition(state, action: PayloadAction<BackfillPayload>) {
      const { requisitionId, rawLotId, operator } = action.payload
      const requisition = state.requisitions.find((item) => item.id === requisitionId)
      if (!requisition) return
      if (requisition.rawLotId && !requisition.backfilled) return
      const rawLot = state.rawLots.find((item) => item.id === rawLotId)
      if (!rawLot) return

      // 冻结批次禁止再领用：补链到已冻结的召回批次时只登记不发料
      const recalledBy = state.cases.filter((recallCase) => recallCase.recalledLots.some((lot) => lot.rawLotId === rawLotId))
      requisition.rawLotId = rawLotId
      requisition.backfilled = true
      if (recalledBy.length > 0) requisition.frozenByCaseId = recalledBy[0].id

      // 缺链节点此前在所有在办召回案中都无法判定：无论回填到哪个批次，
      // 凡范围包含该生产批次的召回案都必须按领料单重算，不能因为回填到安全批次就不核查
      const impactedCases = state.cases.filter(
        (recallCase) => recallCase.status === 'open' && recallCase.scopeNodes.some((node) => node.kind === 'production' && node.nodeId === requisition.productionBatchId)
      )
      for (const recallCase of impactedCases) {
        const hitNow = recallCase.recalledLots.some((lot) => lot.rawLotId === rawLotId)
        audit(state, recallCase.id, '旧单回填原料批次', operator, `${requisition.id}按纸质领料单回填为${rawLotId}${hitNow ? '，命中召回范围，领用同步冻结' : '，未命中召回原料，按重算结果处理'}`, recallCase.scopeVersion)
        const changed = recomputeScope(state, recallCase, `旧领料单${requisition.id}回填原料批次${rawLotId}`, operator)
        if (changed) {
          // 补链若排除嫌疑，关闭对应缺链偏差；命中则保持并转版本
          syncLinkDeviations(state, recallCase, operator)
          const run = generateActions(state, recallCase, operator, { fault: false })
          if (run) recallCase.generationRunId = run.id
        }
      }
      if (impactedCases.length === 0) {
        audit(state, null, '旧单回填原料批次', operator, `${requisition.id}回填为${rawLotId}，与在办召回无关`, null)
      }
    },

    /** 补齐包装时段成品去向；补齐前节点保持待核查 */
    registerMovement(state, action: PayloadAction<RegisterMovementPayload>) {
      const { packagingSessionId, type, destination, qty, operator } = action.payload
      if (!destination.trim() || qty <= 0) return
      const session = state.packagingSessions.find((item) => item.id === packagingSessionId)
      if (!session) return
      const id = `MV-${Date.now().toString().slice(-6)}`
      state.movements.push({
        id,
        packagingSessionId,
        type,
        destination: destination.trim(),
        qty,
        movedAt: new Date().toISOString(),
        holdByCaseId: session.releaseBlockedByCaseId
      })
      const recallCase = state.cases.find((item) => item.scopeNodes.some((node) => node.nodeId === packagingSessionId && node.status !== 'unaffected'))
      if (recallCase) {
        audit(state, recallCase.id, '补登成品去向', operator, `${packagingSessionId}补登流向：${type} ${destination}（${qty}件）`, recallCase.scopeVersion)
        const changedBefore = recallCase.scopeNodes.find((node) => node.nodeId === packagingSessionId)?.status === 'pending_verification'
        const changed = recomputeScope(state, recallCase, `${packagingSessionId}成品去向补齐`, operator)
        if (changed && changedBefore) {
          closeDeviation(state, recallCase.id, packagingSessionId, 'destination_gap', operator, '成品流向已补齐并核实')
          const run = generateActions(state, recallCase, operator, { fault: false })
          if (run) recallCase.generationRunId = run.id
        }
      }
    },

    /** 两个班长同时提交处置确认：乐观版本锁，后提交者看到范围变化且保留本人记录 */
    submitDisposition(state, action: PayloadAction<SubmitDispositionPayload>) {
      const { caseId, leader, decision, note, baseVersion } = action.payload
      const recallCase = findCase(state, caseId)
      if (recallCase.confirmations.some((item) => item.leader === leader && item.state === 'active')) {
        audit(state, caseId, '处置确认拦截', leader, `${leader}的有效处置确认已存在，未重复生成`, recallCase.scopeVersion)
        return
      }
      const stale = baseVersion !== recallCase.scopeVersion
      const scopeChangeNote = stale ? describeScopeChange(recallCase, baseVersion) : ''
      const confirmation: DispositionConfirmation = {
        id: `CNF-${state.seq + 1}-${leader.replace(/\s/g, '')}`,
        caseId,
        leader,
        decision,
        note,
        baseVersion,
        acceptedVersion: stale ? null : recallCase.scopeVersion,
        state: stale ? 'stale_retained' : 'active',
        submittedAt: new Date().toISOString(),
        scopeChangeNote
      }
      state.seq += 1
      recallCase.confirmations.unshift(confirmation)
      if (stale) {
        audit(state, caseId, '处置确认失效保留', leader, `${leader}基于V${baseVersion}提交，当前范围已为V${recallCase.scopeVersion}：${scopeChangeNote}；记录保留，需按新范围重新确认`, recallCase.scopeVersion)
      } else {
        audit(state, caseId, '处置确认生效', leader, `${leader}按V${recallCase.scopeVersion}确认处置：${decision}；${note}`, recallCase.scopeVersion)
      }
    },

    /** 失效确认的持有者按最新范围重新确认，原失效记录继续保留 */
    rebaseDisposition(state, action: PayloadAction<{ caseId: string; leader: string; decision: DispositionConfirmation['decision']; note: string }>) {
      const { caseId, leader, decision, note } = action.payload
      const recallCase = findCase(state, caseId)
      if (recallCase.confirmations.some((item) => item.leader === leader && item.state === 'active')) return
      const version = recallCase.scopeVersion
      recallCase.confirmations.unshift({
        id: `CNF-${state.seq + 1}-${leader.replace(/\s/g, '')}`,
        caseId,
        leader,
        decision,
        note,
        baseVersion: version,
        acceptedVersion: version,
        state: 'active',
        submittedAt: new Date().toISOString(),
        scopeChangeNote: ''
      })
      state.seq += 1
      audit(state, caseId, '处置确认重新生效', leader, `${leader}按最新范围V${version}重新确认：${decision}`, version)
    },

    /** 恢复写入失败的运行：只续跑未完成批次，已确认结果不重复 */
    resumeFailedRun(state, action: PayloadAction<{ caseId: string; operator: string }>) {
      const recallCase = findCase(state, action.payload.caseId)
      const runId = recallCase.generationRunId
      const run = runId ? state.runs.find((item) => item.id === runId) : undefined
      if (!run || run.status !== 'failed') return
      const result = resumeActionGeneration(state, recallCase, run.id)
      commitRunResult(state, result.state)
      const refreshed = state.runs.find((item) => item.id === run.id)!
      audit(state, recallCase.id, '恢复未完成动作', action.payload.operator, `运行${run.id}恢复：补做${refreshed.doneKeys.filter((key) => !run.doneKeys.includes(key)).length}项，累计入账${refreshed.doneKeys.length}项，已确认结果未重复生成`, recallCase.scopeVersion)
    },

    /** 演练：下一次动作生成在过半处写入失败 */
    armWriteFault(state, _action: PayloadAction<{ caseId: string; operator: string }>) {
      state.faultInjection = true
      const recallCase = findCase(state, _action.payload.caseId)
      audit(state, recallCase.id, '演练故障注入', _action.payload.operator, '下一次处置动作生成将在中途写入失败，用于验证恢复', recallCase.scopeVersion)
    },

    /** 对当前范围再跑一次动作生成（范围扩展后调用；幂等） */
    regenerateActions(state, action: PayloadAction<{ caseId: string; operator: string }>) {
      const recallCase = findCase(state, action.payload.caseId)
      const run = generateActions(state, recallCase, action.payload.operator, { fault: state.faultInjection })
      if (run) recallCase.generationRunId = run.id
    },

    /** 仓库尝试再次发料：命中冻结批次的领用一律拒绝 */
    attemptIssueRaw(state, action: PayloadAction<{ rawLotId: string; operator: string }>) {
      const { rawLotId, operator } = action.payload
      const rawLot = state.rawLots.find((item) => item.id === rawLotId)
      if (!rawLot) return
      if (rawLot.frozenByCaseId) {
        audit(state, rawLot.frozenByCaseId, '冻结后领用拦截', operator, `原料批次${rawLotId}已被召回案${rawLot.frozenByCaseId}冻结，仓库发料被拒绝`, null)
      } else {
        audit(state, null, '原料领用', operator, `原料批次${rawLotId}状态正常，允许发料`, null)
      }
    },

    closeDeviationById(state, action: PayloadAction<{ deviationId: string; operator: string; note: string }>) {
      const deviation = state.deviations.find((item) => item.id === action.payload.deviationId)
      if (!deviation || deviation.status === 'closed') return
      const recallCase = state.cases.find((item) => item.id === deviation.caseId)
      deviation.status = 'closed'
      deviation.closedAt = new Date().toISOString()
      deviation.note = `${deviation.note}｜关闭说明：${action.payload.note}`
      audit(state, deviation.caseId, '关闭召回偏差', action.payload.operator, `${deviation.title}已关闭（V${recallCase?.scopeVersion ?? '-'}）`, recallCase?.scopeVersion ?? null)
    },

    resetRecallDemo() {
      return buildRecallSeed()
    }
  }
})

/** 回填后关闭已被安全批次排除的缺链偏差（节点不再处于 pending_link） */
function syncLinkDeviations(state: RecallState, recallCase: RecallCase, operator: string) {
  const linkNodes = new Set(recallCase.scopeNodes.filter((node) => node.status === 'pending_link').map((node) => node.nodeId))
  for (const deviation of state.deviations) {
    if (deviation.caseId !== recallCase.id || deviation.kind !== 'missing_link' || deviation.status !== 'open') continue
    if (!linkNodes.has(deviation.nodeId)) {
      deviation.status = 'closed'
      deviation.closedAt = new Date().toISOString()
      deviation.recallVersion = recallCase.scopeVersion
      deviation.note = `${deviation.note}｜回填后链路已明确，节点按V${recallCase.scopeVersion}重新判定`
      audit(state, recallCase.id, '关闭召回偏差', operator, `${deviation.title}回填后关闭（V${recallCase.scopeVersion}）`, recallCase.scopeVersion)
    }
  }
}

function closeDeviation(state: RecallState, caseId: string, nodeId: string, kind: 'destination_gap' | 'missing_link', operator: string, note: string) {
  const deviation = state.deviations.find((item) => item.caseId === caseId && item.nodeId === nodeId && item.kind === kind && item.status === 'open')
  if (!deviation) return
  const recallCase = state.cases.find((item) => item.id === caseId)
  deviation.status = 'closed'
  deviation.closedAt = new Date().toISOString()
  deviation.recallVersion = recallCase?.scopeVersion ?? deviation.recallVersion
  deviation.note = `${deviation.note}｜${note}`
  audit(state, caseId, '关闭召回偏差', operator, `${deviation.title}（V${recallCase?.scopeVersion ?? '-'}）`, recallCase?.scopeVersion ?? null)
}

/** 对比班长提交时基准版本与当前版本，描述范围变化 */
function describeScopeChange(recallCase: RecallCase, baseVersion: number): string {
  const base = recallCase.snapshots.find((snapshot) => snapshot.version === baseVersion)
  const current = recallCase.snapshots.find((snapshot) => snapshot.version === recallCase.scopeVersion)
  if (!current) return '当前范围无法定位'
  const baseIds = new Set(base?.nodeIds ?? [])
  const currentIds = new Set(current.nodeIds)
  const added = current.nodeIds.filter((id) => !baseIds.has(id))
  const removed = [...baseIds].filter((id) => !currentIds.has(id))
  const changed: string[] = []
  if (base) {
    const baseStatus = new Map(base.nodes.map((node) => [node.nodeId, node.status]))
    for (const node of current.nodes) {
      const previous = baseStatus.get(node.nodeId)
      if (previous && previous !== node.status) changed.push(`${node.nodeId}: ${statusLabel(previous)}→${statusLabel(node.status)}`)
    }
  }
  const parts: string[] = []
  if (added.length) parts.push(`新增命中 ${added.join('、')}`)
  if (removed.length) parts.push(`移出范围 ${removed.join('、')}`)
  if (changed.length) parts.push(`状态变化 ${changed.join('；')}`)
  return parts.length ? parts.join('；') : `范围版本由V${baseVersion}更新为V${recallCase.scopeVersion}`
}

function statusLabel(status: string): string {
  return ({ affected: '命中', pending_verification: '待核查', pending_link: '待补链', unaffected: '无影响' } as Record<string, string>)[status] ?? status
}

export const {
  createRecallCase,
  backfillRequisition,
  registerMovement,
  submitDisposition,
  rebaseDisposition,
  resumeFailedRun,
  armWriteFault,
  regenerateActions,
  attemptIssueRaw,
  closeDeviationById,
  resetRecallDemo
} = slice.actions

export default slice.reducer
