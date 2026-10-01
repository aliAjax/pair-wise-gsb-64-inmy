export type BatchStatus = '生产中' | '待复核' | '可放行' | '隔离中' | '已放行' | '已报废'
export type DeviationStatus = '待调查' | '调查中' | '待复核' | '已关闭'
export type DecisionType = '返工' | '报废' | '让步接收'
export type TraceStatus = '已链接' | '待补链'
export type RecallStatus = '待核查' | '处置中' | '已完成'
export type MaterialLotStatus = '可用' | '冻结'
export type RequisitionStatus = '已领用' | '冻结'

export interface ProcessStep {
  id: string
  name: string
  equipment: string
  hazard: string
  controlPoint: string
  limit: string
  frequency: string
  correctiveAction: string
}

export interface MonitoringValue {
  stepId: string
  value: number
  unit: string
  recordedAt: string
  operator: string
}

export interface Batch {
  id: string
  product: string
  line: string
  quantity: number
  producedAt: string
  status: BatchStatus
  isolationScope: string
  monitoring: MonitoringValue[]
  materialLotIds: string[]
  traceStatus: TraceStatus
  recallId: string | null
  version: number
}

export interface Investigation {
  cause: string
  evidence: string
  decision: DecisionType
  reworkInstruction: string
}

export interface Deviation {
  id: string
  batchId: string
  stepId: string
  title: string
  severity: '一般' | '重大'
  status: DeviationStatus
  owner: string
  openedAt: string
  dueDate: string
  investigation: Investigation
  reviewNote: string
  reviewer: string
  recallId: string | null
  version: number
}

export interface AuditEntry {
  id: string
  entity: string
  action: string
  operator: string
  detail: string
  recallId?: string | null
  createdAt: string
}

export interface MaterialLot {
  id: string
  material: string
  supplier: string
  receivedAt: string
  status: MaterialLotStatus
  recallId: string | null
}

export interface Requisition {
  id: string
  materialLotId: string
  batchId: string
  quantity: number
  unit: string
  issuedAt: string
  status: RequisitionStatus
}

export interface Shipment {
  id: string
  batchId: string
  destination: string
  packagingShift: string
  quantity: number
  shippedAt: string
}

export interface DisposalConfirmation {
  id: string
  recallId: string
  batchIds: string[]
  leader: string
  decision: DecisionType
  note: string
  baseVersion: number
  status: '已确认' | '范围已变更'
  createdAt: string
}

export interface PendingWrite {
  requestId: string
  remainingBatchIds: string[]
  phase: '写入中' | '已恢复'
}

export interface RecallAction {
  id: string
  noticeId: string
  supplier: string
  materialLotId: string
  reason: string
  version: number
  status: RecallStatus
  affectedBatchIds: string[]
  confirmations: DisposalConfirmation[]
  pendingWrite: PendingWrite | null
  createdAt: string
  createdBy: string
}
