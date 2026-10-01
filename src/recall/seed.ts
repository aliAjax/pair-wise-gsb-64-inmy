import type { RecallState } from './types'

// 场景：供应商 SUP-MILK 通知原料批次 RAW-260927-03 召回。
// 仓库纸质领料单记录了生产领用关系，其中一张旧单没填原料批次。
export function buildRecallSeed(): RecallState {
  const rawLots = [
    { id: 'RAW-260927-02', material: '全脂生乳', supplier: 'SUP-MILK 北方牧场', receivedAt: '2026-09-27T05:10:00', frozenByCaseId: null },
    { id: 'RAW-260927-03', material: '全脂生乳', supplier: 'SUP-MILK 北方牧场', receivedAt: '2026-09-27T15:40:00', frozenByCaseId: null },
    { id: 'RAW-260927-04', material: '全脂生乳', supplier: 'SUP-MILK 北方牧场', receivedAt: '2026-09-28T04:55:00', frozenByCaseId: null }
  ]

  const productionBatches = [
    { id: 'B260928-07', product: '低脂牛奶 1L', line: 'L1', quantity: 5100, producedAt: '2026-09-28T16:20:00', requisitionIds: ['REQ-P-1042', 'REQ-P-1046'], releaseBlockedByCaseId: null },
    { id: 'B260929-01', product: '低温鲜奶 950mL', line: 'L1', quantity: 3200, producedAt: '2026-09-29T06:20:00', requisitionIds: ['REQ-P-1051'], releaseBlockedByCaseId: null },
    { id: 'B260929-02', product: '原味酸奶 200g', line: 'L2', quantity: 8600, producedAt: '2026-09-29T08:10:00', requisitionIds: ['REQ-P-1053', 'REQ-P-1054'], releaseBlockedByCaseId: null },
    { id: 'B260929-05', product: '低脂牛奶 1L', line: 'L1', quantity: 2600, producedAt: '2026-09-29T13:40:00', requisitionIds: ['REQ-P-1058'], releaseBlockedByCaseId: null },
    { id: 'B260930-01', product: '低温鲜奶 950mL', line: 'L1', quantity: 3000, producedAt: '2026-09-30T05:30:00', requisitionIds: ['REQ-P-1062'], releaseBlockedByCaseId: null }
  ]

  const requisitions = [
    // 旧纸质单：当时没记录原料批次，只能事后回填补链
    { id: 'REQ-P-1042', paperNo: '纸-0928-07', rawLotId: null, productionBatchId: 'B260928-07', issuedAt: '2026-09-28T15:05:00', issuedQty: 4200, backfilled: false, frozenByCaseId: null },
    { id: 'REQ-P-1046', paperNo: '电-0928-11', rawLotId: 'RAW-260927-02', productionBatchId: 'B260928-07', issuedAt: '2026-09-28T15:40:00', issuedQty: 1200, backfilled: false, frozenByCaseId: null },
    { id: 'REQ-P-1051', paperNo: '纸-0929-02', rawLotId: 'RAW-260927-03', productionBatchId: 'B260929-01', issuedAt: '2026-09-29T05:30:00', issuedQty: 3600, backfilled: false, frozenByCaseId: null },
    { id: 'REQ-P-1053', paperNo: '纸-0929-04', rawLotId: 'RAW-260927-03', productionBatchId: 'B260929-02', issuedAt: '2026-09-29T07:05:00', issuedQty: 5400, backfilled: false, frozenByCaseId: null },
    // 同一批次的另一张领料单指向安全批次：批次仍命中，但保留多批次构成
    { id: 'REQ-P-1054', paperNo: '电-0929-05', rawLotId: 'RAW-260927-04', productionBatchId: 'B260929-02', issuedAt: '2026-09-29T07:30:00', issuedQty: 3200, backfilled: false, frozenByCaseId: null },
    { id: 'REQ-P-1058', paperNo: '纸-0929-09', rawLotId: null, productionBatchId: 'B260929-05', issuedAt: '2026-09-29T12:35:00', issuedQty: 2800, backfilled: false, frozenByCaseId: null },
    // 冻结后尝试再领用 RAW-260927-03：应被拒绝
    { id: 'REQ-P-1062', paperNo: '纸-0930-01', rawLotId: 'RAW-260927-03', productionBatchId: 'B260930-01', issuedAt: '2026-09-30T04:40:00', issuedQty: 3100, backfilled: false, frozenByCaseId: null }
  ]

  const packagingSessions = [
    { id: 'PKG-2901-A', productionBatchId: 'B260929-01', line: 'L1', startedAt: '2026-09-29T09:10:00', endedAt: '2026-09-29T11:30:00', qty: 3200, releaseBlockedByCaseId: null },
    { id: 'PKG-2902-A', productionBatchId: 'B260929-02', line: 'L2', startedAt: '2026-09-29T11:00:00', endedAt: '2026-09-29T13:20:00', qty: 5600, releaseBlockedByCaseId: null },
    // 去向未登记：无任何流向记录，必须留在待核查
    { id: 'PKG-2902-B', productionBatchId: 'B260929-02', line: 'L2', startedAt: '2026-09-29T13:30:00', endedAt: '2026-09-29T15:10:00', qty: 3000, releaseBlockedByCaseId: null },
    { id: 'PKG-2807-A', productionBatchId: 'B260928-07', line: 'L1', startedAt: '2026-09-28T18:00:00', endedAt: '2026-09-28T20:00:00', qty: 5100, releaseBlockedByCaseId: null },
    { id: 'PKG-2905-A', productionBatchId: 'B260929-05', line: 'L1', startedAt: '2026-09-29T15:30:00', endedAt: '2026-09-29T17:00:00', qty: 2600, releaseBlockedByCaseId: null },
    { id: 'PKG-3001-A', productionBatchId: 'B260930-01', line: 'L1', startedAt: '2026-09-30T08:00:00', endedAt: '2026-09-30T09:30:00', qty: 3000, releaseBlockedByCaseId: null }
  ]

  const movements: RecallState['movements'] = [
    { id: 'MV-5001', packagingSessionId: 'PKG-2901-A', type: '经销商在途', destination: 'DC-华北02 冷链车 京A·R8821', qty: 3200, movedAt: '2026-09-29T12:10:00', holdByCaseId: null },
    { id: 'MV-5002', packagingSessionId: 'PKG-2902-A', type: '门店', destination: '连锁便利 北京东区 46店', qty: 4000, movedAt: '2026-09-29T14:00:00', holdByCaseId: null },
    { id: 'MV-5003', packagingSessionId: 'PKG-2902-A', type: '成品库', destination: '中央冷库 B-12 货位', qty: 1600, movedAt: '2026-09-29T14:20:00', holdByCaseId: null },
    { id: 'MV-5004', packagingSessionId: 'PKG-2807-A', type: '门店', destination: '已铺货 华北门店 120店', qty: 5100, movedAt: '2026-09-28T21:00:00', holdByCaseId: null },
    { id: 'MV-5005', packagingSessionId: 'PKG-2905-A', type: '成品库', destination: '中央冷库 B-08 货位', qty: 2600, movedAt: '2026-09-29T17:30:00', holdByCaseId: null },
    { id: 'MV-5006', packagingSessionId: 'PKG-3001-A', type: '成品库', destination: '中央冷库 B-14 货位', qty: 3000, movedAt: '2026-09-30T10:00:00', holdByCaseId: null }
  ]

  return {
    rawLots,
    requisitions,
    productionBatches,
    packagingSessions,
    movements,
    cases: [],
    deviations: [],
    actionLedger: [],
    runs: [],
    audit: [],
    faultInjection: false,
    seq: 0
  }
}
