import type { AppDispatch, RootState } from './index'
import { applyBatchDisposal, beginDisposalWrite, finalizeDisposalWrite, recoverDisposalWrite, type DisposalSubmission } from './haccpSlice'

export interface DisposalSubmissionPayload extends DisposalSubmission {
  simulateFailure?: boolean
}

export type DisposalOutcome = 'applied' | 'conflict' | 'failed' | 'duplicate'

// 处置确认按批次逐个写入：版本冲突只保留记录，写入中断恢复未完成批次，重试凭请求号幂等续写。
export function submitDisposalConfirmation(payload: DisposalSubmissionPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): DisposalOutcome => {
    dispatch(beginDisposalWrite(payload))
    const recall = getState().haccp.recalls.find((item) => item.id === payload.recallId)
    if (!recall) return 'conflict'
    if (recall.confirmations.some((item) => item.id === payload.requestId && item.status === '已确认')) return 'duplicate'
    const pending = recall.pendingWrite
    if (!pending || pending.requestId !== payload.requestId || pending.phase !== '写入中') return 'conflict'
    let written = 0
    for (const batchId of [...pending.remainingBatchIds]) {
      // 故障注入：多批时中断在首批写入之后，单批时中断在写入之前。
      if (payload.simulateFailure && (written > 0 || pending.remainingBatchIds.length === 1)) {
        dispatch(recoverDisposalWrite({ recallId: payload.recallId, requestId: payload.requestId, operator: payload.leader }))
        return 'failed'
      }
      dispatch(applyBatchDisposal({ recallId: payload.recallId, requestId: payload.requestId, batchId, leader: payload.leader, decision: payload.decision }))
      written += 1
    }
    dispatch(finalizeDisposalWrite(payload))
    return 'applied'
  }
}
