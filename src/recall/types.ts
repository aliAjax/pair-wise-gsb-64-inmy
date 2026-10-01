// 原料召回与追溯领域模型

export type RecallNodeStatus = 'affected' | 'pending_verification' | 'pending_link' | 'unaffected'

/** 成品去向环节 */
export type MovementType = '成品库' | '经销商在途' | '门店' | '退货暂存'

/** 召回版本下挂的偏差类型 */
export type RecallDeviationKind = 'missing_link' | 'destination_gap'
export type RecallDeviationStatus = 'open' | 'closed'

export type DispositionDecision = '拦截封存' | '退回供应商' | '报废销毁'
export type DispositionState = 'active' | 'stale_retained'

export type CaseStatus = 'open' | 'closed'
export type ActionRunStatus = 'running' | 'done' | 'failed'

/** 原料批次（供应商批次） */
export interface RawMaterialLot {
  id: string
  material: string
  supplier: string
  receivedAt: string
  /** 被哪个召回案冻结；冻结后禁止新领用 */
  frozenByCaseId: string | null
}

/** 纸质/电子领料单：旧单可能缺失原料批次，需要回填补链 */
export interface RequisitionSlip {
  id: string
  paperNo: string
  rawLotId: string | null
  productionBatchId: string
  issuedAt: string
  issuedQty: number
  backfilled: boolean
  frozenByCaseId: string | null
}

/** 生产批次（由领料单追到原料批次） */
export interface ProductionBatch {
  id: string
  product: string
  line: string
  quantity: number
  producedAt: string
  requisitionIds: string[]
  /** 放行冻结：affected / pending_verification 命中即冻结放行 */
  releaseBlockedByCaseId: string | null
}

/** 包装时段（成品去向的下一段） */
export interface PackagingSession {
  id: string
  productionBatchId: string
  line: string
  startedAt: string
  endedAt: string
  qty: number
  releaseBlockedByCaseId: string | null
}

/** 成品流向记录；去向是否补齐按包装时段是否有去向记录判断 */
export interface FinishedMovement {
  id: string
  packagingSessionId: string
  type: MovementType
  destination: string
  qty: number
  movedAt: string
  holdByCaseId: string | null
}

export interface RecalledLot {
  rawLotId: string
  reason: string
}

/** 召回范围节点：生产批次与包装时段统一口径 */
export interface ScopeNode {
  nodeId: string
  kind: 'production' | 'packaging'
  label: string
  parentId: string | null
  productionBatchId: string
  rawLotId: string | null
  requisitionId: string | null
  status: RecallNodeStatus
  /** 最近一次进入范围所依据的召回版本 */
  scopeVersion: number
  note: string
}

/** 召回版本下挂的偏差（缺链 / 去向未补齐） */
export interface RecallDeviation {
  id: string
  caseId: string
  kind: RecallDeviationKind
  nodeId: string
  title: string
  status: RecallDeviationStatus
  owner: string
  openedAt: string
  closedAt: string | null
  /** 始终对齐到所在召回案当前版本 */
  recallVersion: number
  note: string
}

export interface ActionLedgerEntry {
  id: string
  caseId: string
  runId: string | null
  actionKey: string
  target: string
  description: string
  appliedAt: string
}

export interface ActionRun {
  id: string
  caseId: string
  status: ActionRunStatus
  /** 尚未完成的动作键：写入失败后据此恢复，不重复已确认结果 */
  pendingKeys: string[]
  doneKeys: string[]
  startedAt: string
  finishedAt: string | null
  failure: string | null
}

export interface ScopeSnapshot {
  version: number
  nodeIds: string[]
  /** 该版本下各节点状态，供后提交者对比范围变化 */
  nodes: Array<{ nodeId: string; status: RecallNodeStatus }>
  publishedAt: string
  note: string
}

export interface DispositionConfirmation {
  id: string
  caseId: string
  leader: string
  decision: DispositionDecision
  note: string
  /** 提交时所依据的范围版本（乐观锁） */
  baseVersion: number
  /** 实际生效的范围版本；与提交时不一致则保留记录但标记失效 */
  acceptedVersion: number | null
  state: DispositionState
  submittedAt: string
  /** 后提交者看到的范围变化 */
  scopeChangeNote: string
}

export interface RecallCase {
  id: string
  noticeNo: string
  supplier: string
  title: string
  receivedAt: string
  status: CaseStatus
  recalledLots: RecalledLot[]
  scopeVersion: number
  scopeNodes: ScopeNode[]
  snapshots: ScopeSnapshot[]
  confirmations: DispositionConfirmation[]
  generationRunId: string | null
}

export interface RecallAuditEntry {
  id: string
  caseId: string | null
  action: string
  operator: string
  detail: string
  createdAt: string
  /** 同一召回版本：批次、偏差、审计显示同一个版本号 */
  recallVersion: number | null
}

export interface RecallState {
  rawLots: RawMaterialLot[]
  requisitions: RequisitionSlip[]
  productionBatches: ProductionBatch[]
  packagingSessions: PackagingSession[]
  movements: FinishedMovement[]
  cases: RecallCase[]
  deviations: RecallDeviation[]
  actionLedger: ActionLedgerEntry[]
  runs: ActionRun[]
  audit: RecallAuditEntry[]
  /** 演练用：让下一次动作生成在中途写入失败 */
  faultInjection: boolean
  seq: number
}
