import { createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit'
import { processSteps, seedAudit, seedBatches, seedDeviations, seedMaterialLots, seedRequisitions, seedShipments } from '../data/seed'
import type {
  AuditEntry, Batch, BatchStatus, DecisionType, Deviation, DeviationStatus, Investigation, MaterialLot,
  ProcessStep, RecallAction, RecallStatus, Requisition, Shipment
} from '../types'

interface HaccpState {
  batches: Batch[]
  deviations: Deviation[]
  processSteps: ProcessStep[]
  audit: AuditEntry[]
  materialLots: MaterialLot[]
  requisitions: Requisition[]
  shipments: Shipment[]
  recalls: RecallAction[]
  batchFilter: string
  batchStatus: BatchStatus | '全部'
  selectedBatchId: string | null
}

interface PersistedState extends HaccpState {}
const STORAGE_KEY = 'gsb64:haccp-platform'

export interface DisposalSubmission {
  recallId: string
  requestId: string
  batchIds: string[]
  leader: string
  decision: DecisionType
  note: string
  baseVersion: number
}

function freshState(): HaccpState {
  return {
    batches: structuredClone(seedBatches),
    deviations: structuredClone(seedDeviations),
    processSteps: structuredClone(processSteps),
    audit: structuredClone(seedAudit),
    materialLots: structuredClone(seedMaterialLots),
    requisitions: structuredClone(seedRequisitions),
    shipments: structuredClone(seedShipments),
    recalls: [],
    batchFilter: '',
    batchStatus: '全部',
    selectedBatchId: seedBatches[0].id
  }
}

// 旧版本持久化数据缺少召回相关字段，加载时按默认值补齐。
function migrate(parsed: Partial<HaccpState>): HaccpState {
  const fresh = freshState()
  return {
    ...fresh,
    ...parsed,
    batches: (parsed.batches ?? fresh.batches).map((batch) => ({ ...batch, materialLotIds: batch.materialLotIds ?? [], traceStatus: batch.traceStatus ?? '待补链', recallId: batch.recallId ?? null })),
    deviations: (parsed.deviations ?? fresh.deviations).map((item) => ({ ...item, recallId: item.recallId ?? null })),
    materialLots: parsed.materialLots ?? fresh.materialLots,
    requisitions: parsed.requisitions ?? fresh.requisitions,
    shipments: parsed.shipments ?? fresh.shipments,
    recalls: parsed.recalls ?? fresh.recalls
  }
}

function initialState(): HaccpState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return migrate(JSON.parse(raw))
  } catch {
    // Seed data remains available when local storage is unavailable or corrupt.
  }
  return freshState()
}

function confirmedBatchIds(recall: RecallAction): Set<string> {
  return new Set(recall.confirmations.filter((item) => item.status === '已确认').flatMap((item) => item.batchIds))
}

function shippedQuantity(shipments: Shipment[], batchId: string): number {
  return shipments.filter((item) => item.batchId === batchId).reduce((sum, item) => sum + item.quantity, 0)
}

// 批次去向是否已核清：报废/返工在厂内闭环，让步接收与未确认批次必须发运数量覆盖产量。
function batchAccounted(recall: RecallAction, batches: Batch[], shipments: Shipment[], batchId: string): boolean {
  const confirmation = recall.confirmations.find((item) => item.status === '已确认' && item.batchIds.includes(batchId))
  if (confirmation && confirmation.decision !== '让步接收') return true
  const batch = batches.find((item) => item.id === batchId)
  if (!batch) return false
  return shippedQuantity(shipments, batchId) >= batch.quantity
}

function computeRecallStatus(recall: RecallAction, batches: Batch[], shipments: Shipment[]): RecallStatus {
  const confirmed = confirmedBatchIds(recall)
  const allConfirmed = recall.affectedBatchIds.every((id) => confirmed.has(id))
  const allAccounted = recall.affectedBatchIds.every((id) => batchAccounted(recall, batches, shipments, id))
  if (allConfirmed && allAccounted) return '已完成'
  if (!allAccounted) return '待核查'
  return '处置中'
}

function recordStaleConfirmation(state: HaccpState, recall: RecallAction, payload: DisposalSubmission) {
  if (recall.confirmations.some((item) => item.id === payload.requestId)) return
  recall.confirmations.unshift({
    id: payload.requestId, recallId: recall.id, batchIds: payload.batchIds, leader: payload.leader,
    decision: payload.decision, note: payload.note, baseVersion: payload.baseVersion,
    status: '范围已变更', createdAt: new Date().toISOString()
  })
  log(state, recall.id, '处置确认范围冲突', payload.leader, `基于召回V${payload.baseVersion}提交，当前V${recall.version}，提交记录已保留，需按最新范围重新确认`, recall.id)
}

const slice = createSlice({
  name: 'haccp',
  initialState,
  reducers: {
    setBatchFilter(state, action: PayloadAction<string>) { state.batchFilter = action.payload },
    setBatchStatus(state, action: PayloadAction<BatchStatus | '全部'>) { state.batchStatus = action.payload },
    setSelectedBatch(state, action: PayloadAction<string | null>) { state.selectedBatchId = action.payload },
    updateProcessStep(state, action: PayloadAction<ProcessStep>) {
      const index = state.processSteps.findIndex((item) => item.id === action.payload.id)
      if (index >= 0) state.processSteps[index] = action.payload
      log(state, action.payload.id, '修改控制措施', '质量主管', `更新${action.payload.name}关键限值或监控要求`)
    },
    updateBatchStatus(state, action: PayloadAction<{ id: string; status: BatchStatus }>) {
      const batch = state.batches.find((item) => item.id === action.payload.id)
      if (!batch) return
      const blocking = state.deviations.some((item) => item.batchId === batch.id && item.status !== '已关闭')
      if (action.payload.status === '可放行' && blocking) return
      if ((action.payload.status === '可放行' || action.payload.status === '已放行') && batch.recallId) {
        const recall = state.recalls.find((item) => item.id === batch.recallId)
        if (recall && recall.status !== '已完成') return // 召回冻结：命中批次禁止放行
      }
      batch.status = action.payload.status
      batch.version += 1
      log(state, batch.id, '批次状态流转', '质量主管', `状态更新为${action.payload.status}`, batch.recallId)
    },
    createDeviation(state, action: PayloadAction<{ batchId: string; stepId: string; title: string; severity: '一般' | '重大'; owner: string }>) {
      const batch = state.batches.find((item) => item.id === action.payload.batchId)
      if (!batch) return
      const now = new Date().toISOString()
      const deviation: Deviation = {
        id: `DEV-${Date.now().toString().slice(-8)}`, ...action.payload, status: '待调查', openedAt: now,
        dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), reviewNote: '', reviewer: '', version: 1, recallId: null,
        investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' }
      }
      state.deviations.unshift(deviation)
      batch.status = '隔离中'
      batch.version += 1
      log(state, deviation.id, '创建偏差调查', '当前用户', `批次${batch.id}因${action.payload.title}进入隔离`)
    },
    saveInvestigation(state, action: PayloadAction<{ id: string; investigation: Investigation }>) {
      const deviation = state.deviations.find((item) => item.id === action.payload.id)
      if (!deviation || !action.payload.investigation.cause.trim() || !action.payload.investigation.evidence.trim()) return
      deviation.investigation = action.payload.investigation
      deviation.status = '待复核'
      deviation.version += 1
      log(state, deviation.id, '提交偏差调查', deviation.owner, `处置分支：${deviation.investigation.decision}`, deviation.recallId)
    },
    reviewDeviation(state, action: PayloadAction<{ id: string; approved: boolean; note: string; reviewer: string }>) {
      const deviation = state.deviations.find((item) => item.id === action.payload.id)
      if (!deviation) return
      if (action.payload.approved && !action.payload.note.trim()) return
      deviation.reviewNote = action.payload.note
      deviation.reviewer = action.payload.reviewer
      deviation.status = action.payload.approved ? '已关闭' : '调查中'
      deviation.version += 1
      const batch = state.batches.find((item) => item.id === deviation.batchId)
      if (batch && action.payload.approved && !state.deviations.some((item) => item.batchId === batch.id && item.status !== '已关闭' && item.id !== deviation.id)) {
        batch.status = deviation.investigation.decision === '报废' ? '已报废' : '待复核'
        batch.version += 1
      }
      log(state, deviation.id, action.payload.approved ? '复核通过' : '退回补证', action.payload.reviewer, action.payload.note || '退回调查', deviation.recallId)
    },
    // 旧数据迁移：按领料单回填原料批次，缺失领料记录的标记为待补链。
    backfillMaterialLots(state, action: PayloadAction<{ operator: string }>) {
      let linked = 0
      let missing = 0
      state.batches.forEach((batch) => {
        const lots = [...new Set(state.requisitions.filter((item) => item.batchId === batch.id).map((item) => item.materialLotId))]
        batch.materialLotIds = lots
        batch.traceStatus = lots.length ? '已链接' : '待补链'
        batch.version += 1
        if (lots.length) linked += 1
        else missing += 1
      })
      log(state, '原料链回填', '按领料单回填原料批次', action.payload.operator, `已链接${linked}批，${missing}批缺失领料记录标记为待补链`)
    },
    // 同一通知编号只受理一次；命中批次立即冻结放行与后续领用，待补链批次无法排除一并纳入待核查。
    acceptRecallNotice(state, action: PayloadAction<{ noticeId: string; materialLotId: string; reason: string; operator: string }>) {
      const noticeId = action.payload.noticeId.trim()
      if (!noticeId || !action.payload.reason.trim()) return
      if (state.recalls.some((item) => item.noticeId === noticeId)) return
      const lot = state.materialLots.find((item) => item.id === action.payload.materialLotId)
      if (!lot) return
      const now = new Date().toISOString()
      const recallId = `RC-${noticeId}`
      const linked = state.requisitions.filter((item) => item.materialLotId === lot.id).map((item) => item.batchId)
      const unresolved = state.batches.filter((item) => item.traceStatus === '待补链').map((item) => item.id)
      const affectedBatchIds = [...new Set([...linked, ...unresolved])]
      const recall: RecallAction = {
        id: recallId, noticeId, supplier: lot.supplier, materialLotId: lot.id, reason: action.payload.reason.trim(),
        version: 1, status: '待核查', affectedBatchIds, confirmations: [], pendingWrite: null,
        createdAt: now, createdBy: action.payload.operator
      }
      state.recalls.unshift(recall)
      lot.status = '冻结'
      lot.recallId = recallId
      state.requisitions.forEach((item) => { if (item.materialLotId === lot.id) item.status = '冻结' })
      affectedBatchIds.forEach((batchId, index) => {
        const batch = state.batches.find((item) => item.id === batchId)
        if (!batch) return
        batch.recallId = recallId
        if (batch.status !== '已报废') {
          batch.status = '隔离中'
          batch.isolationScope = `召回冻结 ${recallId}：${recall.reason}`
          batch.version += 1
        }
        const deviation: Deviation = {
          id: `DEV-R${Date.now().toString().slice(-6)}-${index + 1}`, batchId, stepId: 'P1',
          title: `供应商召回：${lot.material} ${lot.id}`, severity: '重大', status: '待调查', owner: '质量工程组',
          openedAt: now, dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
          investigation: { cause: '', evidence: '', decision: '返工', reworkInstruction: '' },
          reviewNote: '', reviewer: '', version: 1, recallId
        }
        state.deviations.unshift(deviation)
      })
      recall.status = computeRecallStatus(recall, state.batches, state.shipments)
      log(state, recallId, '受理供应商召回通知', action.payload.operator, `原料批次${lot.id}命中${affectedBatchIds.length}个生产批次，立即冻结放行与后续领用`, recallId)
    },
    // 冻结批次禁止领用；正常领用同时把生产批次链接到原料批次。
    issueMaterial(state, action: PayloadAction<{ materialLotId: string; batchId: string; quantity: number; operator: string }>) {
      const lot = state.materialLots.find((item) => item.id === action.payload.materialLotId)
      const batch = state.batches.find((item) => item.id === action.payload.batchId)
      if (!lot || !batch || action.payload.quantity <= 0) return
      if (lot.status === '冻结') {
        log(state, lot.id, '领用被冻结拦截', action.payload.operator, `原料批次${lot.id}处于召回冻结，禁止后续领用`, lot.recallId)
        return
      }
      const requisition: Requisition = {
        id: `REQ-${Date.now().toString().slice(-8)}`, materialLotId: lot.id, batchId: batch.id,
        quantity: action.payload.quantity, unit: 'kg', issuedAt: new Date().toISOString(), status: '已领用'
      }
      state.requisitions.unshift(requisition)
      if (!batch.materialLotIds.includes(lot.id)) batch.materialLotIds.push(lot.id)
      batch.traceStatus = '已链接'
      batch.version += 1
      log(state, requisition.id, '新建领料单', action.payload.operator, `${batch.id}领用${lot.id} ${action.payload.quantity}kg`)
    },
    // 补齐成品去向：去向范围变化会提升召回版本，在途的处置确认将按冲突处理。
    addShipment(state, action: PayloadAction<{ recallId: string; batchId: string; destination: string; packagingShift: string; quantity: number; operator: string }>) {
      const recall = state.recalls.find((item) => item.id === action.payload.recallId)
      const batch = state.batches.find((item) => item.id === action.payload.batchId)
      if (!recall || !batch || !recall.affectedBatchIds.includes(batch.id)) return
      if (!action.payload.destination.trim() || !action.payload.packagingShift.trim() || action.payload.quantity <= 0) return
      state.shipments.unshift({
        id: `SH-${Date.now().toString().slice(-8)}`, batchId: batch.id, destination: action.payload.destination.trim(),
        packagingShift: action.payload.packagingShift.trim(), quantity: action.payload.quantity, shippedAt: new Date().toISOString()
      })
      recall.version += 1
      recall.status = computeRecallStatus(recall, state.batches, state.shipments)
      log(state, batch.id, '补齐成品去向', action.payload.operator, `${action.payload.packagingShift}发往${action.payload.destination} ${action.payload.quantity}件，召回版本升至V${recall.version}`, recall.id)
    },
    // 乐观并发入口：版本不一致只保留提交记录不应用；相同请求号断点续写。
    beginDisposalWrite(state, action: PayloadAction<DisposalSubmission>) {
      const recall = state.recalls.find((item) => item.id === action.payload.recallId)
      if (!recall || recall.status === '已完成') return
      const { requestId, baseVersion } = action.payload
      if (recall.confirmations.some((item) => item.id === requestId && item.status === '已确认')) return
      if (recall.pendingWrite) {
        if (recall.pendingWrite.requestId === requestId && recall.version === baseVersion) {
          recall.pendingWrite.phase = '写入中'
          return
        }
        if (recall.pendingWrite.requestId !== requestId) {
          log(state, recall.id, '写入失败恢复', '系统', `请求${recall.pendingWrite.requestId}未完成，剩余批次已恢复待确认`, recall.id)
          recall.pendingWrite = null
        } else {
          recall.pendingWrite = null
          recordStaleConfirmation(state, recall, action.payload)
          return
        }
      }
      if (recall.version !== baseVersion) {
        recordStaleConfirmation(state, recall, action.payload)
        return
      }
      const confirmed = confirmedBatchIds(recall)
      const batchIds = action.payload.batchIds.filter((id) => recall.affectedBatchIds.includes(id) && !confirmed.has(id))
      if (!batchIds.length) return
      recall.pendingWrite = { requestId, remainingBatchIds: batchIds, phase: '写入中' }
    },
    // 逐批写入：已写入的批次在重试时跳过，已确认结果不会重复生成。
    applyBatchDisposal(state, action: PayloadAction<{ recallId: string; requestId: string; batchId: string; leader: string; decision: DecisionType }>) {
      const recall = state.recalls.find((item) => item.id === action.payload.recallId)
      if (!recall || !recall.pendingWrite || recall.pendingWrite.requestId !== action.payload.requestId || recall.pendingWrite.phase !== '写入中') return
      if (!recall.pendingWrite.remainingBatchIds.includes(action.payload.batchId)) return
      const batch = state.batches.find((item) => item.id === action.payload.batchId)
      if (!batch) return
      batch.status = action.payload.decision === '报废' ? '已报废' : action.payload.decision === '让步接收' ? '待复核' : '隔离中'
      batch.isolationScope = `召回处置 ${recall.id}：${action.payload.decision}`
      batch.version += 1
      recall.pendingWrite.remainingBatchIds = recall.pendingWrite.remainingBatchIds.filter((id) => id !== action.payload.batchId)
      log(state, batch.id, '召回处置写入', action.payload.leader, `处置决定：${action.payload.decision}`, recall.id)
    },
    // 写入失败：未完成批次恢复待确认，保留请求号以便安全重试。
    recoverDisposalWrite(state, action: PayloadAction<{ recallId: string; requestId: string; operator: string }>) {
      const recall = state.recalls.find((item) => item.id === action.payload.recallId)
      if (!recall || !recall.pendingWrite || recall.pendingWrite.requestId !== action.payload.requestId) return
      const restored = recall.pendingWrite.remainingBatchIds
      recall.pendingWrite.phase = '已恢复'
      log(state, recall.id, '写入失败恢复', action.payload.operator, `写入中断，未完成批次${restored.join('、') || '无'}已恢复待确认；已写入结果保留且不会重复生成`, recall.id)
    },
    // 收尾：全部批次写入完成才生成确认记录并提升召回版本。
    finalizeDisposalWrite(state, action: PayloadAction<DisposalSubmission>) {
      const recall = state.recalls.find((item) => item.id === action.payload.recallId)
      if (!recall || !recall.pendingWrite || recall.pendingWrite.requestId !== action.payload.requestId) return
      if (recall.pendingWrite.remainingBatchIds.length > 0) return
      if (!recall.confirmations.some((item) => item.id === action.payload.requestId)) {
        recall.confirmations.unshift({
          id: action.payload.requestId, recallId: recall.id, batchIds: action.payload.batchIds, leader: action.payload.leader,
          decision: action.payload.decision, note: action.payload.note, baseVersion: action.payload.baseVersion,
          status: '已确认', createdAt: new Date().toISOString()
        })
      }
      recall.pendingWrite = null
      recall.version += 1
      recall.status = computeRecallStatus(recall, state.batches, state.shipments)
      log(state, recall.id, '处置确认完成', action.payload.leader, `${action.payload.batchIds.length}个批次确认${action.payload.decision}，召回版本升至V${recall.version}`, recall.id)
    },
    resetDemo() {
      return freshState()
    }
  }
})

function log(state: HaccpState, entity: string, action: string, operator: string, detail: string, recallId: string | null = null) {
  state.audit.unshift({ id: nanoid(), entity, action, operator, detail, recallId, createdAt: new Date().toISOString() })
}

export const {
  setBatchFilter, setBatchStatus, setSelectedBatch, updateProcessStep, updateBatchStatus, createDeviation,
  saveInvestigation, reviewDeviation, backfillMaterialLots, acceptRecallNotice, issueMaterial, addShipment,
  beginDisposalWrite, applyBatchDisposal, recoverDisposalWrite, finalizeDisposalWrite, resetDemo
} = slice.actions
export type { PersistedState }
export default slice.reducer
