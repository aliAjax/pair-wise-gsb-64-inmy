import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import { seedBatches } from '../data/seed'
import type { Batch, Requisition } from '../types'

export const haccpApi = createApi({
  reducerPath: 'haccpApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    loadBatchSnapshot: builder.query<Batch[], void>({
      queryFn: async () => ({ data: structuredClone(seedBatches) })
    }),
    checkReleaseReadiness: builder.query<{ ready: boolean; reasons: string[] }, { batchId: string; openDeviations: number }>({
      queryFn: async ({ batchId, openDeviations }) => ({
        data: {
          ready: openDeviations === 0,
          reasons: openDeviations === 0 ? [] : [`${batchId}仍有${openDeviations}项未关闭偏差`]
        }
      })
    }),
    // 受理通知前预演追溯：按领料单命中生产批次，待补链批次无法排除一并列出。
    traceMaterialLot: builder.query<{ batchIds: string[]; unresolvedBatchIds: string[] }, { lotId: string; requisitions: Requisition[]; batches: Batch[] }>({
      queryFn: async ({ lotId, requisitions, batches }) => ({
        data: {
          batchIds: [...new Set(requisitions.filter((item) => item.materialLotId === lotId).map((item) => item.batchId))],
          unresolvedBatchIds: batches.filter((item) => item.traceStatus === '待补链').map((item) => item.id)
        }
      })
    })
  })
})

export const { useLoadBatchSnapshotQuery, useCheckReleaseReadinessQuery, useTraceMaterialLotQuery } = haccpApi
