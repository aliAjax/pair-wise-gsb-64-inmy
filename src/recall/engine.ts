import type {
  ActionLedgerEntry,
  ActionRun,
  ProductionBatch,
  RecallCase,
  RecallDeviation,
  RecallNodeStatus,
  RecallState,
  ScopeNode,
  ScopeSnapshot
} from './types'

/** 一张领料单在某召回案中的命中情况 */
interface RequisitionHit {
  requisitionId: string
  productionBatchId: string
  rawLotId: string | null
  status: RecallNodeStatus
  note: string
}

/**
 * 追溯判定（纯函数）：
 * - 领料单原料批次 ∈ 召回批次            => affected
 * - 领料单缺失原料批次（旧纸质单未回填）  => pending_link
 * - 其他                                  => 不进入范围
 * 生产批次只要有任一单命中即为命中，命中等级取 affected > pending_link。
 */
export function classifyRequisitions(state: Pick<RecallState, 'requisitions'>, recalledLotIds: Set<string>): RequisitionHit[] {
  return state.requisitions
    .map((req): RequisitionHit | null => {
      if (req.rawLotId && recalledLotIds.has(req.rawLotId)) {
        return { requisitionId: req.id, productionBatchId: req.productionBatchId, rawLotId: req.rawLotId, status: 'affected' as const, note: `领料单${req.paperNo}命中召回原料批次${req.rawLotId}` }
      }
      if (!req.rawLotId) {
        return { requisitionId: req.id, productionBatchId: req.productionBatchId, rawLotId: null, status: 'pending_link' as const, note: `旧领料单${req.paperNo}缺失原料批次，待补链` }
      }
      return null
    })
    .filter((hit): hit is RequisitionHit => hit !== null)
}

const STATUS_RANK: Record<RecallNodeStatus, number> = { affected: 3, pending_verification: 2, pending_link: 1, unaffected: 0 }

/**
 * 计算召回范围快照（纯函数，不修改状态）。
 * 生产批次 -> 包装时段 -> 成品去向：
 * - 命中批次/包装时段，且其包装时段全部有成品去向记录 => affected
 * - 命中但存在无去向记录的包装时段                     => pending_verification（去向未补齐，不能当无影响）
 * - 缺链批次                                          => pending_link
 */
export function computeScope(state: RecallState, recalled: RecallCase['recalledLots']): ScopeNode[] {
  const recalledLotIds = new Set(recalled.map((item) => item.rawLotId))
  const hits = classifyRequisitions(state, recalledLotIds)

  const bestHitByBatch = new Map<string, RequisitionHit>()
  for (const hit of hits) {
    const current = bestHitByBatch.get(hit.productionBatchId)
    if (!current || STATUS_RANK[hit.status] > STATUS_RANK[current.status]) bestHitByBatch.set(hit.productionBatchId, hit)
  }

  const nodes: ScopeNode[] = []

  for (const batch of state.productionBatches) {
    const hit = bestHitByBatch.get(batch.id)
    if (!hit) continue
    const sessions = state.packagingSessions.filter((session) => session.productionBatchId === batch.id)
    const sessionsWithoutMovement = sessions.filter((session) => !state.movements.some((movement) => movement.packagingSessionId === session.id))

    let batchStatus: RecallNodeStatus = hit.status
    let batchNote = hit.note
    if (hit.status === 'affected' && sessionsWithoutMovement.length > 0) {
      batchStatus = 'pending_verification'
      batchNote = `生产批次命中召回原料；${sessionsWithoutMovement.map((session) => session.id).join('、')}成品去向未补齐，留待核查`
    }

    nodes.push({
      nodeId: batch.id,
      kind: 'production',
      label: `${batch.id} ${batch.product}`,
      parentId: null,
      productionBatchId: batch.id,
      rawLotId: hit.rawLotId,
      requisitionId: hit.requisitionId,
      status: batchStatus,
      scopeVersion: 0,
      note: batchNote
    })

    for (const session of sessions) {
      const sessionMovements = state.movements.filter((movement) => movement.packagingSessionId === session.id)
      let sessionStatus: RecallNodeStatus
      let note: string
      if (hit.status === 'pending_link') {
        sessionStatus = 'pending_link'
        note = '上游领料单原料批次待补链'
      } else if (sessionMovements.length === 0) {
        sessionStatus = 'pending_verification'
        note = '该包装时段无成品流向记录，去向待核查，不得按无影响处理'
      } else {
        sessionStatus = 'affected'
        note = `成品已流向：${sessionMovements.map((movement) => movement.destination).join('；')}`
      }
      nodes.push({
        nodeId: session.id,
        kind: 'packaging',
        label: `${session.id} 包装时段 ${session.startedAt.slice(5, 16).replace('T', ' ')}–${session.endedAt.slice(11, 16)}`,
        parentId: batch.id,
        productionBatchId: batch.id,
        rawLotId: hit.rawLotId,
        requisitionId: hit.requisitionId,
        status: sessionStatus,
        scopeVersion: 0,
        note
      })
    }
  }

  return nodes
}

export function scopeNodeIds(nodes: ScopeNode[]): string[] {
  return nodes.map((node) => node.nodeId).sort()
}

/** 范围是否较上一版本发生变化（节点集合、状态或链路依据变化） */
export function scopeChanged(previous: ScopeNode[] | undefined, next: ScopeNode[]): boolean {
  if (!previous) return true
  if (scopeNodeIds(previous).join('|') !== scopeNodeIds(next).join('|')) return true
  const prevById = new Map(previous.map((node) => [node.nodeId, node]))
  return next.some((node) => {
    const old = prevById.get(node.nodeId)
    return !old || old.status !== node.status || old.note !== node.note || old.rawLotId !== node.rawLotId || old.requisitionId !== node.requisitionId
  })
}

export interface PlannedAction {
  actionKey: string
  target: string
  description: string
  apply: (state: RecallState) => void
}

/**
 * 依据范围节点生成处置动作。动作键幂等：已确认（已入账）的结果不会重复生成。
 * - 命中批次/包装时段：冻结放行
 * - 领料单命中召回批次：冻结后续领用
 * - 已流向成品：冻结在途/库存
 * - 缺链、去向缺口：生成召回偏差
 */
export function planActions(state: RecallState, recallCase: RecallCase): PlannedAction[] {
  const version = recallCase.scopeVersion
  const nodes = recallCase.scopeNodes
  const actions: PlannedAction[] = []
  const caseId = recallCase.id

  const hitRequisitions = classifyRequisitions(state, new Set(recallCase.recalledLots.map((item) => item.rawLotId)))
  const affectedRequisitions = hitRequisitions.filter((hit) => hit.status === 'affected')
  for (const hit of affectedRequisitions) {
    actions.push({
      actionKey: `freeze-requisition:${hit.requisitionId}`,
      target: hit.requisitionId,
      description: `冻结领料单${hit.requisitionId}对应原料的后续领用`,
      apply: (draft) => {
        const requisition = draft.requisitions.find((item) => item.id === hit.requisitionId)
        if (requisition && requisition.frozenByCaseId !== caseId) requisition.frozenByCaseId = caseId
      }
    })
  }

  // 命中即冻结原料批次本身，阻止任何新领用
  for (const lot of recallCase.recalledLots) {
    actions.push({
      actionKey: `freeze-raw-lot:${lot.rawLotId}`,
      target: lot.rawLotId,
      description: `冻结召回原料批次${lot.rawLotId}，仓库禁止发料`,
      apply: (draft) => {
        const rawLot = draft.rawLots.find((item) => item.id === lot.rawLotId)
        if (rawLot && rawLot.frozenByCaseId !== caseId) rawLot.frozenByCaseId = caseId
      }
    })
  }

  for (const node of nodes) {
    if (node.kind === 'production') {
      actions.push({
        actionKey: `block-release:${node.nodeId}`,
        target: node.nodeId,
        description: `生产批次${node.nodeId}冻结放行（${node.status === 'pending_verification' ? '去向待核查' : node.status === 'pending_link' ? '链路待补' : '命中召回'}）`,
        apply: (draft) => {
          const batch = draft.productionBatches.find((item) => item.id === node.nodeId)
          if (batch && batch.releaseBlockedByCaseId !== caseId) batch.releaseBlockedByCaseId = caseId
        }
      })
    } else {
      actions.push({
        actionKey: `block-release:${node.nodeId}`,
        target: node.nodeId,
        description: `包装时段${node.nodeId}冻结放行`,
        apply: (draft) => {
          const session = draft.packagingSessions.find((item) => item.id === node.nodeId)
          if (session && session.releaseBlockedByCaseId !== caseId) session.releaseBlockedByCaseId = caseId
        }
      })
    }
  }

  // 成品去向冻结：仅冻结命中范围包装时段下的已登记流向
  const affectedSessionIds = new Set(nodes.filter((node) => node.kind === 'packaging' && node.status !== 'pending_link').map((node) => node.nodeId))
  for (const movement of state.movements) {
    if (affectedSessionIds.has(movement.packagingSessionId)) {
      actions.push({
        actionKey: `hold-movement:${movement.id}`,
        target: movement.id,
        description: `冻结成品去向${movement.id}（${movement.type} ${movement.destination}）`,
        apply: (draft) => {
          const target = draft.movements.find((item) => item.id === movement.id)
          if (target && target.holdByCaseId !== caseId) target.holdByCaseId = caseId
        }
      })
    }
  }

  // 范围收缩后的对账：补链证实无关的批次/包装时段解除放行冻结，流向解冻
  const inScopeIds = new Set(nodes.map((node) => node.nodeId))
  for (const batch of state.productionBatches) {
    if (batch.releaseBlockedByCaseId === caseId && !inScopeIds.has(batch.id)) {
      actions.push({
        actionKey: `unblock-release:${batch.id}`,
        target: batch.id,
        description: `${batch.id}补链证实未使用召回原料，解除召回放行冻结`,
        apply: (draft) => {
          const target = draft.productionBatches.find((item) => item.id === batch.id)
          if (target && target.releaseBlockedByCaseId === caseId) target.releaseBlockedByCaseId = null
        }
      })
    }
  }
  for (const session of state.packagingSessions) {
    if (session.releaseBlockedByCaseId === caseId && !inScopeIds.has(session.id)) {
      actions.push({
        actionKey: `unblock-release:${session.id}`,
        target: session.id,
        description: `包装时段${session.id}移出召回范围，解除放行冻结`,
        apply: (draft) => {
          const target = draft.packagingSessions.find((item) => item.id === session.id)
          if (target && target.releaseBlockedByCaseId === caseId) target.releaseBlockedByCaseId = null
        }
      })
    }
  }
  for (const movement of state.movements) {
    if (movement.holdByCaseId === caseId && !affectedSessionIds.has(movement.packagingSessionId)) {
      actions.push({
        actionKey: `release-movement:${movement.id}`,
        target: movement.id,
        description: `成品去向${movement.id}随范围收缩解除冻结`,
        apply: (draft) => {
          const target = draft.movements.find((item) => item.id === movement.id)
          if (target && target.holdByCaseId === caseId) target.holdByCaseId = null
        }
      })
    }
  }
  const affectedRequisitionIds = new Set(affectedRequisitions.map((hit) => hit.requisitionId))
  for (const requisition of state.requisitions) {
    if (requisition.frozenByCaseId === caseId && !affectedRequisitionIds.has(requisition.id)) {
      actions.push({
        actionKey: `unfreeze-requisition:${requisition.id}`,
        target: requisition.id,
        description: `领料单${requisition.id}回填后未命中召回批次，解除领用冻结`,
        apply: (draft) => {
          const target = draft.requisitions.find((item) => item.id === requisition.id)
          if (target && target.frozenByCaseId === caseId) target.frozenByCaseId = null
        }
      })
    }
  }

  // 偏差：缺链 / 去向缺口
  const existingOpen = new Set(
    state.deviations.filter((deviation) => deviation.caseId === caseId && deviation.status === 'open').map((deviation) => deviation.nodeId + '|' + deviation.kind)
  )
  for (const node of nodes) {
    if (node.status === 'pending_link') {
      const key = `${node.nodeId}|missing_link`
      if (!existingOpen.has(key)) {
        actions.push({
          actionKey: `open-deviation:${node.nodeId}:missing_link`,
          target: node.nodeId,
          description: `挂出缺链偏差：${node.label}原料批次待补链`,
          apply: (draft) => {
            draft.deviations.push({
              id: nextId(draft, 'RDEV'),
              caseId,
              kind: 'missing_link',
              nodeId: node.nodeId,
              title: `${node.nodeId} 原料批次链路缺失`,
              status: 'open',
              owner: '仓库台账组',
              openedAt: now(),
              closedAt: null,
              recallVersion: version,
              note: '按纸质领料单回填原料批次前，该节点保持待补链，不得判定无影响'
            })
          }
        })
      }
    }
    if (node.status === 'pending_verification' && node.kind === 'packaging') {
      const key = `${node.nodeId}|destination_gap`
      if (!existingOpen.has(key)) {
        actions.push({
          actionKey: `open-deviation:${node.nodeId}:destination_gap`,
          target: node.nodeId,
          description: `挂出去向偏差：${node.label}成品去向未补齐`,
          apply: (draft) => {
            draft.deviations.push({
              id: nextId(draft, 'RDEV'),
              caseId,
              kind: 'destination_gap',
              nodeId: node.nodeId,
              title: `${node.nodeId} 成品去向缺口`,
              status: 'open',
              owner: '物流追踪组',
              openedAt: now(),
              closedAt: null,
              recallVersion: version,
              note: '包装时段无流向记录，补齐去向并核实前保持待核查'
            })
          }
        })
      }
    }
  }

  return actions
}

/** 已入账动作键（幂等依据：已确认结果不能重复生成） */
export function appliedActionKeys(state: RecallState, caseId: string): Set<string> {
  return new Set(state.actionLedger.filter((entry) => entry.caseId === caseId).map((entry) => entry.actionKey))
}

export interface RunResult {
  state: RecallState
  run: ActionRun
  applied: ActionLedgerEntry[]
}

/**
 * 执行（或恢复）一次召回动作生成。
 * - 只执行 ledger 中不存在的动作，已确认结果绝不重复；
 * - 每个动作独立落账：中途写入失败时，未完成动作保留在 pendingKeys，
 *   已完成动作保留在 ledger/doneKeys，恢复时只续跑剩余批次；
 * - faultInjection 打开时在过半动作处模拟一次写入失败。
 */
export function runActionGeneration(input: RecallState, recallCase: RecallCase, runId: string | null, resume = false): RunResult {
  // 入口处拍普通对象快照：调用方可能传入 Immer draft 代理，引擎内部全部基于纯数据运算
  const state: RecallState = JSON.parse(JSON.stringify(input))
  recallCase = JSON.parse(JSON.stringify(recallCase))
  const appliedKeys = appliedActionKeys(state, recallCase.id)
  const planned = planActions(state, recallCase).filter((action) => !appliedKeys.has(action.actionKey))
  const allKeys = planned.map((action) => action.actionKey)

  let run: ActionRun
  if (resume && runId) {
    const existing = state.runs.find((item) => item.id === runId)
    if (!existing) throw new Error(`恢复失败：未找到动作运行 ${runId}`)
    run = existing
    run.status = 'running'
    run.failure = null
  } else {
    run = {
      id: runId ?? nextId(state, 'RUN'),
      caseId: recallCase.id,
      status: 'running',
      pendingKeys: allKeys,
      doneKeys: [],
      startedAt: now(),
      finishedAt: null,
      failure: null
    }
    state.runs.unshift(run)
  }

  const applied: ActionLedgerEntry[] = []
  // 故障发生在中间位置：至少完成1项、至少留下1项未完成，用于演示部分写入失败
  const failAfter = state.faultInjection && allKeys.length >= 2 ? Math.min(allKeys.length - 1, Math.max(1, Math.floor(allKeys.length / 2))) : Number.POSITIVE_INFINITY
  let failureAt: string | null = null

  for (const action of planned) {
    if (!run.pendingKeys.includes(action.actionKey)) continue
    if (applied.length >= failAfter) {
      failureAt = `模拟写入失败：动作 ${action.actionKey} 落库中断`
      break
    }
    action.apply(state)
    const entry: ActionLedgerEntry = {
      id: nextId(state, 'ACT'),
      caseId: recallCase.id,
      runId: run.id,
      actionKey: action.actionKey,
      target: action.target,
      description: action.description,
      appliedAt: now()
    }
    state.actionLedger.unshift(entry)
    run.doneKeys.push(action.actionKey)
    run.pendingKeys = run.pendingKeys.filter((key) => key !== action.actionKey)
    applied.push(entry)
  }

  if (failureAt) {
    run.status = 'failed'
    run.failure = failureAt
  } else {
    run.status = 'done'
    run.finishedAt = now()
    run.pendingKeys = []
  }
  // 故障只触发一次：恢复续跑时不再注入
  state.faultInjection = false

  return { state, run, applied }
}

/** 恢复未完成批次：只续跑失败运行剩余的 pendingKeys */
export function resumeActionGeneration(state: RecallState, recallCase: RecallCase, runId: string): RunResult {
  return runActionGeneration(state, recallCase, runId, true)
}

export function makeSnapshot(version: number, nodes: ScopeNode[], note: string): ScopeSnapshot {
  return {
    version,
    nodeIds: scopeNodeIds(nodes),
    nodes: nodes.map((node) => ({ nodeId: node.nodeId, status: node.status })),
    publishedAt: now(),
    note
  }
}

/** 让既有偏差的 recallVersion 始终对齐到当前召回版本（批次、偏差、审计同一版本） */
export function alignDeviationVersions(state: RecallState, caseId: string, version: number): RecallDeviation[] {
  return state.deviations.map((deviation) => (deviation.caseId === caseId ? { ...deviation, recallVersion: version } : deviation))
}

export function nextId(state: RecallState, prefix: string): string {
  state.seq += 1
  return `${prefix}-${state.seq.toString().padStart(4, '0')}`
}

let clock: (() => Date) | null = null
export function setClock(fn: (() => Date) | null) { clock = fn }
export function now(): string {
  return (clock ? clock() : new Date()).toISOString()
}
