import { useEffect, useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Badge, Button, Checkbox, Dropdown, Field, Input, Option, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import { nanoid } from '@reduxjs/toolkit'
import type { AppDispatch, RootState } from '../store'
import { acceptRecallNotice, addShipment, backfillMaterialLots, issueMaterial } from '../store/haccpSlice'
import { submitDisposalConfirmation } from '../store/recallThunks'
import { useTraceMaterialLotQuery } from '../services/api'
import type { DecisionType, RecallAction } from '../types'

const recallColor = (status: RecallAction['status']) => status === '已完成' ? 'success' as const : status === '处置中' ? 'important' as const : 'danger' as const
const decisions: DecisionType[] = ['返工', '报废', '让步接收']

export function RecallCenter() {
  const dispatch = useDispatch<AppDispatch>()
  const state = useSelector((root: RootState) => root.haccp)
  const [selectedId, setSelectedId] = useState(state.recalls[0]?.id ?? '')
  const selected = state.recalls.find((item) => item.id === selectedId) ?? state.recalls[0]

  const [showNotice, setShowNotice] = useState(false)
  const [notice, setNotice] = useState({ noticeId: '', materialLotId: state.materialLots[0]?.id ?? '', reason: '' })
  const noticeExists = notice.noticeId.trim() !== '' && state.recalls.some((item) => item.noticeId === notice.noticeId.trim())
  const { data: tracePreview, isFetching: tracing } = useTraceMaterialLotQuery(
    { lotId: notice.materialLotId, requisitions: state.requisitions, batches: state.batches },
    { skip: !showNotice || !notice.materialLotId }
  )

  // 处置确认表单：baseVersion 在打开召回时捕获，模拟班长手中工单的范围快照，不随后台变化自动刷新。
  const [confirmation, setConfirmation] = useState({ leader: '一班班长 王磊', decision: '报废' as DecisionType, note: '' })
  const [baseVersion, setBaseVersion] = useState<number | null>(null)
  const [requestId, setRequestId] = useState(() => nanoid(8))
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [outcome, setOutcome] = useState<'conflict' | 'failed' | 'applied' | null>(null)
  useEffect(() => {
    setBaseVersion(selected?.version ?? null)
    setRequestId(nanoid(8))
    setOutcome(null)
  }, [selected?.id])

  const [shipment, setShipment] = useState({ batchId: '', destination: '', packagingShift: '', quantity: '' })
  const [issue, setIssue] = useState({ materialLotId: state.materialLots[0]?.id ?? '', batchId: state.batches[0]?.id ?? '', quantity: '' })

  const confirmedIds = useMemo(
    () => new Set((selected?.confirmations ?? []).filter((item) => item.status === '已确认').flatMap((item) => item.batchIds)),
    [selected]
  )
  const pendingBatchIds = selected?.affectedBatchIds.filter((id) => !confirmedIds.has(id)) ?? []
  const shippedOf = (batchId: string) => state.shipments.filter((item) => item.batchId === batchId).reduce((sum, item) => sum + item.quantity, 0)
  const confirmationOf = (batchId: string) => selected?.confirmations.find((item) => item.status === '已确认' && item.batchIds.includes(batchId))
  const unaccountedBatchIds = selected?.affectedBatchIds.filter((id) => {
    const batch = state.batches.find((item) => item.id === id)
    const record = confirmationOf(id)
    if (!batch) return false
    if (record && record.decision !== '让步接收') return false
    return shippedOf(id) < batch.quantity
  }) ?? []
  const shipmentBatchId = shipment.batchId || unaccountedBatchIds[0] || ''
  const shipmentBatch = state.batches.find((item) => item.id === shipmentBatchId)
  const shipmentRemaining = shipmentBatch ? shipmentBatch.quantity - shippedOf(shipmentBatch.id) : 0
  const issueLot = state.materialLots.find((item) => item.id === issue.materialLotId)
  const staleForm = selected !== undefined && baseVersion !== null && baseVersion !== selected.version

  const submitNotice = () => {
    const noticeId = notice.noticeId.trim()
    dispatch(acceptRecallNotice({ noticeId, materialLotId: notice.materialLotId, reason: notice.reason, operator: '质量主管 秦岚' }))
    setSelectedId(`RC-${noticeId}`)
    setShowNotice(false)
    setNotice({ noticeId: '', materialLotId: notice.materialLotId, reason: '' })
  }

  const submitConfirmation = (retry: boolean) => {
    if (!selected || baseVersion === null || !pendingBatchIds.length) return
    const result = dispatch(submitDisposalConfirmation({
      recallId: selected.id, requestId, batchIds: pendingBatchIds, leader: confirmation.leader,
      decision: confirmation.decision, note: confirmation.note, baseVersion, simulateFailure: simulateFailure && !retry
    }))
    if (result === 'applied') {
      setBaseVersion(baseVersion + 1)
      setRequestId(nanoid(8))
      setOutcome('applied')
    } else if (result === 'failed') {
      setOutcome('failed')
    } else {
      setOutcome('conflict')
    }
  }

  const reconfirm = () => {
    if (!selected) return
    setBaseVersion(selected.version)
    setRequestId(nanoid(8))
    setOutcome(null)
  }

  const submitShipment = () => {
    if (!selected || !shipmentBatchId) return
    dispatch(addShipment({
      recallId: selected.id, batchId: shipmentBatchId, destination: shipment.destination,
      packagingShift: shipment.packagingShift, quantity: Number(shipment.quantity), operator: '仓库管理员 孙洁'
    }))
    setShipment({ ...shipment, destination: '', packagingShift: '', quantity: '' })
  }

  const missingChain = state.batches.filter((item) => item.traceStatus === '待补链').length
  const activeRecalls = state.recalls.filter((item) => item.status !== '已完成')
  const pendingCount = activeRecalls.reduce((sum, recall) => sum + recall.affectedBatchIds.filter((id) => {
    const batch = state.batches.find((item) => item.id === id)
    const record = recall.confirmations.find((entry) => entry.status === '已确认' && entry.batchIds.includes(id))
    if (!batch) return false
    if (record && record.decision !== '让步接收') return false
    return state.shipments.filter((entry) => entry.batchId === id).reduce((total, entry) => total + entry.quantity, 0) < batch.quantity
  }).length, 0)

  return (
    <section className="page">
      <header className="page-head">
        <div><p>供应商通知 / 原料到成品追溯</p><h1>召回行动中心</h1></div>
        <div className="head-actions">
          <Button appearance="secondary" onClick={() => dispatch(backfillMaterialLots({ operator: '质量主管 秦岚' }))}>按领料单回填旧数据</Button>
          <Button appearance="primary" onClick={() => setShowNotice(!showNotice)}>登记供应商通知</Button>
        </div>
      </header>
      <div className="metrics">
        <article><span>进行中召回</span><strong>{activeRecalls.length}</strong><small>已完成{state.recalls.length - activeRecalls.length}起</small></article>
        <article><span>冻结原料批次</span><strong>{state.materialLots.filter((item) => item.status === '冻结').length}</strong><small>禁止后续领用</small></article>
        <article><span>待核查批次</span><strong>{pendingCount}</strong><small>去向未补齐不得视为无影响</small></article>
        <article><span>待补链批次</span><strong>{missingChain}</strong><small>缺失领料单记录</small></article>
      </div>
      {showNotice && <div className="edit-panel">
        <h3>受理供应商召回通知</h3>
        <div className="edit-grid">
          <Field label="通知编号（同一通知只受理一次）" validationState={noticeExists ? 'error' : 'none'} validationMessage={noticeExists ? '该通知已受理，不重复建立召回' : undefined}>
            <Input value={notice.noticeId} onChange={(_, data) => setNotice({ ...notice, noticeId: data.value })} placeholder="如 NOTICE-2026-041" />
          </Field>
          <Field label="原料批次">
            <Dropdown value={notice.materialLotId} selectedOptions={[notice.materialLotId]} onOptionSelect={(_, data) => setNotice({ ...notice, materialLotId: data.optionValue ?? '' })}>
              {state.materialLots.map((item) => <Option key={item.id} value={item.id} text={`${item.id} ${item.material} · ${item.supplier}`}>{item.id} {item.material} · {item.supplier}</Option>)}
            </Dropdown>
          </Field>
          <Field label="召回原因"><Input value={notice.reason} onChange={(_, data) => setNotice({ ...notice, reason: data.value })} placeholder="供应商通报的缺陷描述" /></Field>
        </div>
        {tracePreview && <p className="hint-text">
          {tracing ? '正在追溯…' : `按领料单命中批次：${tracePreview.batchIds.join('、') || '无'}；待补链无法排除：${tracePreview.unresolvedBatchIds.join('、') || '无'}。受理后命中批次立即冻结放行与领用。`}
        </p>}
        <div className="record-actions">
          <Button onClick={() => setShowNotice(false)}>取消</Button>
          <Button appearance="primary" disabled={!notice.noticeId.trim() || !notice.reason.trim() || noticeExists} onClick={submitNotice}>受理并冻结命中批次</Button>
        </div>
      </div>}
      <div className="recall-layout">
        <div className="deviation-list">
          {state.recalls.length === 0 && <div className="empty-panel">尚未受理召回通知。先按领料单回填旧数据，再登记供应商通知建立召回行动。</div>}
          {state.recalls.map((item) => <button key={item.id} className={item.id === selected?.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}>
            <div><Badge color={recallColor(item.status)}>{item.status}</Badge><small>{item.id}</small></div>
            <strong>{state.materialLots.find((lot) => lot.id === item.materialLotId)?.material} · {item.noticeId}</strong>
            <span>{item.supplier} · 影响{item.affectedBatchIds.length}批</span>
            <footer><Badge appearance="tint" color="important">召回V{item.version}</Badge><span>{item.createdAt.slice(0, 10)}</span></footer>
          </button>)}
        </div>
        {selected && <div className="panel-stack">
          <div className="record-panel">
            <div className="record-title">
              <div><span>{selected.id} · {selected.noticeId} · 受理人{selected.createdBy}</span><h2>{state.materialLots.find((lot) => lot.id === selected.materialLotId)?.material} 召回 · {selected.supplier}</h2></div>
              <div className="badge-pair"><Badge appearance="tint" color="important">召回V{selected.version}</Badge><Badge color={recallColor(selected.status)}>{selected.status}</Badge></div>
            </div>
            <dl>
              <div><dt>原料批次</dt><dd>{selected.materialLotId}（已冻结）</dd></div>
              <div><dt>召回原因</dt><dd>{selected.reason}</dd></div>
              <div><dt>核查规则</dt><dd>去向未补齐的批次保持待核查，不得视为无影响</dd></div>
            </dl>
            <h3>影响批次与成品去向</h3>
            <Table size="small" aria-label="召回影响批次">
              <TableHeader><TableRow><TableHeaderCell>批次</TableHeaderCell><TableHeaderCell>原料链</TableHeaderCell><TableHeaderCell>成品去向</TableHeaderCell><TableHeaderCell>处置</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {selected.affectedBatchIds.map((batchId) => {
                  const batch = state.batches.find((item) => item.id === batchId)
                  if (!batch) return null
                  const record = confirmationOf(batchId)
                  const shipped = shippedOf(batchId)
                  const accounted = (record && record.decision !== '让步接收') || shipped >= batch.quantity
                  const inFlight = selected.pendingWrite?.remainingBatchIds.includes(batchId)
                  return <TableRow key={batchId}>
                    <TableCell><strong>{batchId}</strong><br /><small>{batch.product}</small></TableCell>
                    <TableCell>{batch.traceStatus === '待补链' ? <Badge color="danger" appearance="tint">待补链</Badge> : <Badge color="success" appearance="tint">已链接</Badge>}<br /><small>{batch.materialLotIds.join('、') || '缺失领料记录'}</small></TableCell>
                    <TableCell>{accounted ? <Badge color="success" appearance="tint">已核清</Badge> : <Badge color="danger" appearance="tint">待核查</Badge>}<br /><small>已发运{shipped}/{batch.quantity}件</small></TableCell>
                    <TableCell>{record ? <span>{record.decision} · {record.leader}</span> : inFlight ? <Badge color="warning" appearance="tint">{selected.pendingWrite?.phase === '写入中' ? '写入中' : '已恢复待确认'}</Badge> : <Badge appearance="tint">待确认</Badge>}</TableCell>
                  </TableRow>
                })}
              </TableBody>
            </Table>
          </div>
          {unaccountedBatchIds.length > 0 && <div className="record-panel">
            <h3>补齐成品去向</h3>
            <div className="inline-form">
              <Field label="批次"><Dropdown value={shipmentBatchId} selectedOptions={[shipmentBatchId]} onOptionSelect={(_, data) => setShipment({ ...shipment, batchId: data.optionValue ?? '' })}>
                {unaccountedBatchIds.map((id) => <Option key={id} value={id} text={id}>{id}</Option>)}
              </Dropdown></Field>
              <Field label="去向客户/仓库"><Input value={shipment.destination} onChange={(_, data) => setShipment({ ...shipment, destination: data.value })} placeholder="如 华南经销商" /></Field>
              <Field label="包装时段"><Input value={shipment.packagingShift} onChange={(_, data) => setShipment({ ...shipment, packagingShift: data.value })} placeholder="如 09-29 14:00-16:00" /></Field>
              <Field label={`数量（剩余${shipmentRemaining}件）`}><Input type="number" value={shipment.quantity} onChange={(_, data) => setShipment({ ...shipment, quantity: data.value })} /></Field>
              <Button appearance="primary" disabled={!shipment.destination.trim() || !shipment.packagingShift.trim() || Number(shipment.quantity) <= 0 || Number(shipment.quantity) > shipmentRemaining} onClick={submitShipment}>登记去向</Button>
            </div>
            <p className="hint-text">登记去向会提升召回版本，其他班长在途的确认单将提示范围变化。</p>
          </div>}
          <div className="record-panel">
            <h3>处置确认（班长工单）</h3>
            {selected.pendingWrite?.phase === '已恢复' && <p className="validation-text">上次写入中断，未完成批次已恢复待确认。点击重试将沿用原请求号续写，已写入批次不会重复生成。</p>}
            {outcome === 'conflict' && <p className="validation-text">提交时召回范围已变更（工单基于V{baseVersion}，当前V{selected.version}），本次未应用；您的提交记录已保留在下方确认记录中，请核对范围后重新确认。</p>}
            {outcome === 'failed' && <p className="validation-text">模拟写入中断：部分批次未写入，已自动恢复待确认，可安全重试。</p>}
            {outcome === 'applied' && <p className="ok-text">处置确认已写入，召回版本升至V{selected.version}。</p>}
            {staleForm && outcome !== 'conflict' && <p className="hint-text">工单基于召回V{baseVersion}，当前已升至V{selected.version}，提交时将按范围冲突处理并保留记录。</p>}
            <div className="inline-form confirm-form">
              <Field label="班长"><Input value={confirmation.leader} onChange={(_, data) => setConfirmation({ ...confirmation, leader: data.value })} /></Field>
              <Field label="处置决定"><Dropdown value={confirmation.decision} selectedOptions={[confirmation.decision]} onOptionSelect={(_, data) => setConfirmation({ ...confirmation, decision: data.optionValue as DecisionType })}>
                {decisions.map((item) => <Option key={item} value={item} text={item}>{item}</Option>)}
              </Dropdown></Field>
              <Field label="备注"><Input value={confirmation.note} onChange={(_, data) => setConfirmation({ ...confirmation, note: data.value })} placeholder="处置说明" /></Field>
              <Checkbox label="模拟写入中断" checked={simulateFailure} onChange={(_, data) => setSimulateFailure(data.checked === true)} />
            </div>
            <div className="record-actions">
              {outcome === 'conflict' && <Button appearance="secondary" onClick={reconfirm}>按当前版本V{selected.version}重新确认</Button>}
              {(outcome === 'failed' || selected.pendingWrite?.phase === '已恢复') && <Button appearance="secondary" onClick={() => submitConfirmation(true)}>重试（恢复未完成批次）</Button>}
              <Button appearance="primary" disabled={!confirmation.leader.trim() || !pendingBatchIds.length || selected.status === '已完成' || selected.pendingWrite?.phase === '写入中'} onClick={() => submitConfirmation(false)}>
                提交处置确认（{pendingBatchIds.length}批 · 基于V{baseVersion ?? '-'}）
              </Button>
            </div>
            {selected.confirmations.length > 0 && <div className="confirm-list">
              {selected.confirmations.map((item) => <div key={item.id} className="confirm-record">
                <Badge color={item.status === '已确认' ? 'success' : 'warning'} appearance="tint">{item.status}</Badge>
                <strong>{item.leader}</strong>
                <span>{item.decision} · {item.batchIds.join('、')}</span>
                <small>基于V{item.baseVersion} · {item.createdAt.replace('T', ' ').slice(5, 16)}{item.note ? ` · ${item.note}` : ''}</small>
              </div>)}
            </div>}
          </div>
          <div className="record-panel">
            <h3>原料批次与领用冻结</h3>
            <Table size="small" aria-label="原料批次">
              <TableHeader><TableRow><TableHeaderCell>原料批次</TableHeaderCell><TableHeaderCell>供应商</TableHeaderCell><TableHeaderCell>状态</TableHeaderCell><TableHeaderCell>领料单</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {state.materialLots.map((lot) => <TableRow key={lot.id}>
                  <TableCell><strong>{lot.id}</strong><br /><small>{lot.material}</small></TableCell>
                  <TableCell>{lot.supplier}</TableCell>
                  <TableCell>{lot.status === '冻结' ? <Badge color="danger" appearance="tint">冻结 · {lot.recallId}</Badge> : <Badge color="success" appearance="tint">可用</Badge>}</TableCell>
                  <TableCell>{state.requisitions.filter((req) => req.materialLotId === lot.id).map((req) => <div key={req.id}><small>{req.id} → {req.batchId}（{req.quantity}{req.unit}）</small>{req.status === '冻结' && <Badge color="danger" appearance="tint">冻结</Badge>}</div>)}</TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
            <h3>新建领料单</h3>
            <div className="inline-form">
              <Field label="原料批次"><Dropdown value={issue.materialLotId} selectedOptions={[issue.materialLotId]} onOptionSelect={(_, data) => setIssue({ ...issue, materialLotId: data.optionValue ?? '' })}>
                {state.materialLots.map((item) => <Option key={item.id} value={item.id} text={`${item.id} ${item.material}`}>{item.id} {item.material}</Option>)}
              </Dropdown></Field>
              <Field label="生产批次"><Dropdown value={issue.batchId} selectedOptions={[issue.batchId]} onOptionSelect={(_, data) => setIssue({ ...issue, batchId: data.optionValue ?? '' })}>
                {state.batches.map((item) => <Option key={item.id} value={item.id} text={`${item.id} ${item.product}`}>{item.id} {item.product}</Option>)}
              </Dropdown></Field>
              <Field label="数量 kg"><Input type="number" value={issue.quantity} onChange={(_, data) => setIssue({ ...issue, quantity: data.value })} /></Field>
              <Button appearance="primary" disabled={!issueLot || issueLot.status === '冻结' || Number(issue.quantity) <= 0} onClick={() => { dispatch(issueMaterial({ materialLotId: issue.materialLotId, batchId: issue.batchId, quantity: Number(issue.quantity), operator: '仓库管理员 孙洁' })); setIssue({ ...issue, quantity: '' }) }}>提交领用</Button>
            </div>
            {issueLot?.status === '冻结' && <p className="validation-text">原料批次{issueLot.id}处于召回冻结（{issueLot.recallId}），后续领用已被拦截。</p>}
          </div>
        </div>}
      </div>
    </section>
  )
}
