import { useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Badge, Button, Dropdown, Field, Input, Option, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Textarea } from '@fluentui/react-components'
import type { AppDispatch, RootState } from '../store'
import {
  armWriteFault,
  attemptIssueRaw,
  backfillRequisition,
  closeDeviationById,
  createRecallCase,
  rebaseDisposition,
  regenerateActions,
  registerMovement,
  resumeFailedRun,
  submitDisposition
} from './recallSlice'
import type { DispositionDecision, MovementType, RecallCase, RecallNodeStatus, ScopeNode } from './types'

const STATUS_TEXT: Record<RecallNodeStatus, string> = {
  affected: '命中·已冻结',
  pending_verification: '待核查（去向未补齐）',
  pending_link: '待补链（原料批次缺失）',
  unaffected: '无影响'
}
const STATUS_COLOR: Record<RecallNodeStatus, 'danger' | 'warning' | 'success' | 'informative'> = {
  affected: 'danger',
  pending_verification: 'warning',
  pending_link: 'warning',
  unaffected: 'success'
}

const DECISIONS: DispositionDecision[] = ['拦截封存', '退回供应商', '报废销毁']
const MOVEMENT_TYPES: MovementType[] = ['成品库', '经销商在途', '门店', '退货暂存']

export function RecallCenter() {
  const dispatch = useDispatch<AppDispatch>()
  const state = useSelector((root: RootState) => root.recall)
  const [caseId, setCaseId] = useState<string | null>(state.cases[0]?.id ?? null)
  const recallCase = state.cases.find((item) => item.id === caseId) ?? state.cases[0]

  return (
    <section className="page recall-page">
      <header className="page-head">
        <div><p>供应商召回通知 / 正向追溯与处置</p><h1>原料召回行动中心</h1></div>
        {recallCase && <span className="sync-state">当前召回版本 <b>V{recallCase.scopeVersion}</b> · {recallCase.noticeNo}</span>}
      </header>

      <NoticeIntake />

      {state.cases.length > 0 && (
        <div className="toolbar">
          <Dropdown value={recallCase?.noticeNo ?? ''} selectedOptions={[recallCase?.id ?? '']} onOptionSelect={(_, data) => setCaseId(data.optionValue ?? null)} style={{ minWidth: 360 }}>
            {state.cases.map((item) => <Option key={item.id} value={item.id} text={item.noticeNo}>{item.noticeNo} · {item.title}（V{item.scopeVersion}）</Option>)}
          </Dropdown>
          <span>同一供应商通知仅受理一次；范围变化以版本快照发布</span>
        </div>
      )}

      {recallCase ? <CaseWorkspace key={recallCase.id} recallCase={recallCase} dispatch={dispatch} state={state} /> : (
        <div className="rule-band"><strong>尚无在办召回</strong><span>受理供应商通知后，系统立即按「原料批次 → 领料单 → 生产批次 → 包装时段 → 成品去向」追溯并冻结。</span></div>
      )}
    </section>
  )
}

function NoticeIntake() {
  const dispatch = useDispatch<AppDispatch>()
  const cases = useSelector((root: RootState) => root.recall.cases)
  const rawLots = useSelector((root: RootState) => root.recall.rawLots)
  const [noticeNo, setNoticeNo] = useState('RN-261001-017')
  const [rawLotId, setRawLotId] = useState('RAW-260927-03')
  const already = cases.some((item) => item.noticeNo === noticeNo)

  return (
    <div className="table-panel intake-panel">
      <div className="intake-head"><strong>① 受理供应商召回通知</strong><span>通知号立案唯一；命中批次立即冻结放行与后续领用</span></div>
      <div className="edit-grid">
        <Field label="供应商召回通知号"><Input value={noticeNo} onChange={(_, data) => setNoticeNo(data.value)} /></Field>
        <Field label="召回原料批次">
          <Dropdown value={rawLotId} selectedOptions={[rawLotId]} onOptionSelect={(_, data) => setRawLotId(data.optionValue ?? rawLotId)}>
            {rawLots.map((lot) => <Option key={lot.id} value={lot.id} text={`${lot.id} ${lot.material}`}>{lot.id} · {lot.material} · {lot.supplier}</Option>)}
          </Dropdown>
        </Field>
        <div className="intake-action">
          <Button appearance="primary" disabled={!noticeNo || already} onClick={() => dispatch(createRecallCase({ noticeNo, supplier: 'SUP-MILK 北方牧场', title: '全脂生乳微生物指标异常召回', rawLotIds: [rawLotId], operator: '质量主管 秦岚' }))}>
            {already ? '该通知已受理' : '立案并立即追溯冻结'}
          </Button>
          {already && <small className="validation-text-inline">同一通知只受理一次</small>}
        </div>
      </div>
    </div>
  )
}

interface WorkspaceProps {
  recallCase: RecallCase
  state: RootState['recall']
  dispatch: AppDispatch
}

function CaseWorkspace({ recallCase, state, dispatch }: WorkspaceProps) {
  const nodes = recallCase.scopeNodes
  const affected = nodes.filter((node) => node.status === 'affected').length
  const pendingVerify = nodes.filter((node) => node.status === 'pending_verification').length
  const pendingLink = nodes.filter((node) => node.status === 'pending_link').length
  const openDeviations = state.deviations.filter((item) => item.caseId === recallCase.id && item.status === 'open')
  const run = recallCase.generationRunId ? state.runs.find((item) => item.id === recallCase.generationRunId) : undefined
  const activeConfirmations = recallCase.confirmations.filter((item) => item.state === 'active')

  return (
    <>
      <div className="metrics">
        <article><span>命中范围节点</span><strong>{affected}</strong><small>生产批次/包装时段已冻结</small></article>
        <article><span>待核查</span><strong>{pendingVerify}</strong><small>去向未补齐，不得判定无影响</small></article>
        <article><span>待补链</span><strong>{pendingLink}</strong><small>旧领料单原料批次缺失</small></article>
        <article><span>未关闭召回偏差</span><strong>{openDeviations.length}</strong><small>缺链 / 去向缺口</small></article>
      </div>

      {run?.status === 'failed' && (
        <div className="validation-text recovery-band">
          <strong>动作写入失败：</strong>{run.failure}
          <span>已确认 {run.doneKeys.length} 项（不会重复生成），剩余 {run.pendingKeys.length} 项待恢复。</span>
          <Button appearance="primary" size="small" onClick={() => dispatch(resumeFailedRun({ caseId: recallCase.id, operator: '系统恢复' }))}>恢复未完成批次</Button>
        </div>
      )}

      <div className="split-layout recall-layout">
        <div className="recall-main">
          <TraceTree recallCase={recallCase} state={state} dispatch={dispatch} />
          <PaperRequisitions recallCase={recallCase} state={state} dispatch={dispatch} />
          <RecallDeviations recallCase={recallCase} state={state} dispatch={dispatch} />
          <ActionLedgerView recallCase={recallCase} state={state} dispatch={dispatch} />
        </div>
        <aside className="recall-side">
          <FreezePanel recallCase={recallCase} state={state} dispatch={dispatch} />

          <DispositionPanel recallCase={recallCase} dispatch={dispatch} activeCount={activeConfirmations.length} />
          <DrillPanel recallCase={recallCase} state={state} dispatch={dispatch} runFailed={run?.status === 'failed'} />
          <RecallAudit recallCase={recallCase} state={state} dispatch={dispatch} />
        </aside>
      </div>
    </>
  )
}

function TraceTree({ recallCase, state, dispatch }: WorkspaceProps) {
  const productionNodes = recallCase.scopeNodes.filter((node) => node.kind === 'production')

  return (
    <div className="table-panel">
      <div className="panel-head"><strong>② 正向追溯：原料批次 → 生产批次 → 包装时段 → 成品去向</strong><span>范围版本 V{recallCase.scopeVersion}</span></div>
      <div className="trace-tree">
        {productionNodes.map((batchNode) => {
          const batch = state.productionBatches.find((item) => item.id === batchNode.nodeId)!
          const sessions = recallCase.scopeNodes.filter((node) => node.kind === 'packaging' && node.parentId === batch.id)
          return (
            <div key={batchNode.nodeId} className="trace-batch">
              <div className="trace-row trace-batch-head">
                <Badge appearance="tint" color={STATUS_COLOR[batchNode.status]}>{STATUS_TEXT[batchNode.status]}</Badge>
                <strong>{batch.id}</strong><span>{batch.product} · {batch.line} · {batch.quantity.toLocaleString()}件</span>
                {batch.releaseBlockedByCaseId === recallCase.id && <Badge color="danger">放行已冻结</Badge>}
              </div>
              <small className="trace-note">{batchNode.note}</small>
              <div className="trace-sessions">
                {sessions.map((sessionNode) => <SessionRow key={sessionNode.nodeId} node={sessionNode} recallCase={recallCase} state={state} dispatch={dispatch} />)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SessionRow({ node, recallCase, state, dispatch }: { node: ScopeNode; recallCase: RecallCase; state: RootState['recall']; dispatch: AppDispatch }) {
  const session = state.packagingSessions.find((item) => item.id === node.nodeId)!
  const movements = state.movements.filter((item) => item.packagingSessionId === session.id)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ type: '成品库' as MovementType, destination: '', qty: session.qty - movements.reduce((sum, item) => sum + item.qty, 0) })

  return (
    <div className="trace-session">
      <div className="trace-row">
        <Badge appearance="tint" color={STATUS_COLOR[node.status]}>{STATUS_TEXT[node.status]}</Badge>
        <span className="session-id">{session.id}</span>
        <small>{session.startedAt.slice(5, 16).replace('T', ' ')} – {session.endedAt.slice(11, 16)} · {session.qty}件</small>
        {session.releaseBlockedByCaseId === recallCase.id && <Badge color="danger">包装冻结</Badge>}
      </div>
      <small className="trace-note">{node.note}</small>
      <div className="trace-movements">
        {movements.length === 0 && <em>无成品流向记录 —— 必须留待核查，不能按无影响处理</em>}
        {movements.map((movement) => (
          <div key={movement.id} className="trace-row trace-movement">
            <span>→ {movement.type} · {movement.destination}</span><small>{movement.qty}件</small>
            {movement.holdByCaseId === recallCase.id && <Badge color="danger">流向已冻结</Badge>}
          </div>
        ))}
        {!adding && node.status === 'pending_verification' && <Button size="small" appearance="subtle" onClick={() => setAdding(true)}>补齐该包装时段去向</Button>}
        {adding && (
          <div className="movement-form">
            <Dropdown value={draft.type} selectedOptions={[draft.type]} onOptionSelect={(_, data) => setDraft({ ...draft, type: data.optionValue as MovementType })}>
              {MOVEMENT_TYPES.map((type) => <Option key={type} value={type}>{type}</Option>)}
            </Dropdown>
            <Input placeholder="流向目的地（门店/承运/货位）" value={draft.destination} onChange={(_, data) => setDraft({ ...draft, destination: data.value })} />
            <Input type="number" value={String(draft.qty)} onChange={(_, data) => setDraft({ ...draft, qty: Number(data.value) })} style={{ maxWidth: 110 }} />
            <Button size="small" appearance="primary" disabled={!draft.destination.trim() || draft.qty <= 0} onClick={() => { dispatch(registerMovement({ packagingSessionId: session.id, ...draft, operator: '物流追踪组 周朴' })); setAdding(false) }}>登记并重新判定</Button>
          </div>
        )}
      </div>
    </div>
  )
}

function PaperRequisitions({ recallCase, state, dispatch }: WorkspaceProps) {
  const inScopeBatchIds = new Set(recallCase.scopeNodes.map((node) => node.productionBatchId))
  const slips = state.requisitions.filter((item) => inScopeBatchIds.has(item.productionBatchId))
  return (
    <div className="table-panel">
      <div className="panel-head"><strong>③ 纸质领料单与旧数据回填</strong><span>缺失原料批次的旧单标记为待补链</span></div>
      <Table size="small">
        <TableHeader><TableRow><TableHeaderCell>领料单</TableHeaderCell><TableHeaderCell>纸单号</TableHeaderCell><TableHeaderCell>生产批次</TableHeaderCell><TableHeaderCell>原料批次</TableHeaderCell><TableHeaderCell>状态</TableHeaderCell><TableHeaderCell>回填</TableHeaderCell></TableRow></TableHeader>
        <TableBody>
          {slips.map((slip) => {
            const recalled = recallCase.recalledLots.some((lot) => lot.rawLotId === slip.rawLotId)
            return (
              <TableRow key={slip.id}>
                <TableCell>{slip.id}</TableCell>
                <TableCell>{slip.paperNo}</TableCell>
                <TableCell>{slip.productionBatchId}</TableCell>
                <TableCell>{slip.rawLotId ? <span className={recalled ? 'hit-text' : ''}>{slip.rawLotId}{recalled && '（召回批次）'}{slip.backfilled && ' · 已回填'}</span> : <Badge color="warning">待补链</Badge>}</TableCell>
                <TableCell>{slip.frozenByCaseId ? <Badge color="danger">领用冻结</Badge> : <Badge color="success">可追溯</Badge>}</TableCell>
                <TableCell>
                  {(!slip.rawLotId || slip.backfilled) ? (
                    <BackfillPicker current={slip.rawLotId} state={state} onPick={(rawLotId) => dispatch(backfillRequisition({ requisitionId: slip.id, rawLotId, operator: '仓库台账组 高媛' }))} />
                  ) : '—'}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function BackfillPicker({ current, state, onPick }: { current: string | null; state: RootState['recall']; onPick: (rawLotId: string) => void }) {
  const [value, setValue] = useState(current ?? state.rawLots[0]?.id ?? '')
  return (
    <span className="backfill-picker">
      <Dropdown size="small" value={value} selectedOptions={[value]} onOptionSelect={(_, data) => setValue(data.optionValue ?? value)} style={{ minWidth: 170 }}>
        {state.rawLots.map((lot) => <Option key={lot.id} value={lot.id} text={lot.id}>{lot.id}</Option>)}
      </Dropdown>
      <Button size="small" appearance="secondary" onClick={() => onPick(value)}>按纸单回填</Button>
    </span>
  )
}

function RecallDeviations({ recallCase, state, dispatch }: WorkspaceProps) {
  const deviations = state.deviations.filter((item) => item.caseId === recallCase.id)
  return (
    <div className="table-panel">
      <div className="panel-head"><strong>④ 召回偏差</strong><span>批次、偏差、审计显示同一召回版本 V{recallCase.scopeVersion}</span></div>
      {deviations.length === 0 ? <em>暂无偏差</em> : (
        <div className="deviation-cards">
          {deviations.map((deviation) => (
            <div key={deviation.id} className={`deviation-card ${deviation.status}`}>
              <div><Badge color={deviation.status === 'open' ? 'danger' : 'success'}>{deviation.status === 'open' ? '未关闭' : '已关闭'}</Badge><Badge appearance="outline">V{deviation.recallVersion}</Badge></div>
              <strong>{deviation.title}</strong>
              <span>{deviation.kind === 'missing_link' ? '原料批次缺链' : '成品去向缺口'} · 责任人 {deviation.owner}</span>
              <small>{deviation.note}</small>
              {deviation.status === 'open' && <Button size="small" appearance="subtle" onClick={() => dispatch(closeDeviationById({ deviationId: deviation.id, operator: '质量主管 秦岚', note: '现场核查确认链路/去向已补齐' }))}>核查关闭</Button>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActionLedgerView({ recallCase, state }: WorkspaceProps) {
  const entries = state.actionLedger.filter((entry) => entry.caseId === recallCase.id)
  return (
    <div className="table-panel">
      <div className="panel-head"><strong>⑤ 处置动作账（幂等）</strong><span>已确认结果不重复生成 · 共 {entries.length} 项</span></div>
      <Table size="small">
        <TableHeader><TableRow><TableHeaderCell>动作键</TableHeaderCell><TableHeaderCell>对象</TableHeaderCell><TableHeaderCell>说明</TableHeaderCell><TableHeaderCell>时间</TableHeaderCell></TableRow></TableHeader>
        <TableBody>
          {entries.map((entry) => <TableRow key={entry.id}><TableCell><code>{entry.actionKey}</code></TableCell><TableCell>{entry.target}</TableCell><TableCell>{entry.description}</TableCell><TableCell>{entry.appliedAt.slice(5, 16).replace('T', ' ')}</TableCell></TableRow>)}
        </TableBody>
      </Table>
    </div>
  )
}

function FreezePanel({ recallCase, state, dispatch }: { recallCase: RecallCase; state: RootState['recall']; dispatch: AppDispatch }) {
  const [lotId, setLotId] = useState(recallCase.recalledLots[0]?.rawLotId ?? state.rawLots[0]?.id ?? '')
  const isFrozen = state.rawLots.find((lot) => lot.id === lotId)?.frozenByCaseId === recallCase.id
  return (
    <div className="record-panel side-panel">
      <div className="record-title"><div><span>放行与领用冻结</span><h2>命中即冻结</h2></div></div>
      <p className="side-text">命中生产批次、包装时段禁止放行；召回原料批次禁止仓库发料。下方模拟仓库再次领料：</p>
      <Field label="原料批次">
        <Dropdown value={lotId} selectedOptions={[lotId]} onOptionSelect={(_, data) => setLotId(data.optionValue ?? lotId)}>
          {state.rawLots.map((lot) => <Option key={lot.id} value={lot.id} text={`${lot.id}${lot.frozenByCaseId ? '（已冻结）' : ''}`}>{lot.id}{lot.frozenByCaseId ? '（已冻结）' : ''}</Option>)}
        </Dropdown>
      </Field>
      <div className="record-actions"><Button appearance={isFrozen ? 'primary' : 'secondary'} onClick={() => dispatch(attemptIssueRaw({ rawLotId: lotId, operator: '仓库领料员 冯堃' }))}>尝试再次领用</Button></div>
      <small className="side-text">{isFrozen ? `该批次被 ${state.rawLots.find((lot) => lot.id === lotId)?.frozenByCaseId} 冻结，发料将被拦截` : '未命中召回，允许发料'}</small>
    </div>
  )
}

function DispositionPanel({ recallCase, dispatch, activeCount }: { recallCase: RecallCase; dispatch: AppDispatch; activeCount: number }) {
  const leaders = ['甲班 班长 何巍', '乙班 班长 沈牧']
  return (
    <div className="record-panel side-panel">
      <div className="record-title"><div><span>两班长并行处置确认</span><h2>乐观版本锁</h2></div><Badge appearance="tint" color="informative">范围 V{recallCase.scopeVersion}</Badge></div>
      <p className="side-text">两班长可同时基于同一范围版本提交；范围先行变化时，后提交者的确认标记失效但本人记录保留，并可按新版本重新确认。</p>
      {leaders.map((leader) => <LeaderConfirm key={leader} leader={leader} recallCase={recallCase} dispatch={dispatch} />)}
      <small className="side-text">当前有效确认 {activeCount}/2；回填或补齐去向会发布新版本。</small>
    </div>
  )
}

function LeaderConfirm({ leader, recallCase, dispatch }: { leader: string; recallCase: RecallCase; dispatch: AppDispatch }) {
  const existing = recallCase.confirmations.find((item) => item.leader === leader && item.state === 'active')
  const stale = recallCase.confirmations.find((item) => item.leader === leader && item.state === 'stale_retained')
  const [baseVersion, setBaseVersion] = useState(recallCase.scopeVersion)
  const [decision, setDecision] = useState<DispositionDecision>('拦截封存')
  const [note, setNote] = useState('')

  if (existing) {
    return <div className="confirm-card active"><Badge color="success">生效</Badge><strong>{leader}</strong><small>基于 V{existing.baseVersion} · {existing.decision}</small><small>{existing.note || '—'}</small></div>
  }
  if (stale) {
    return (
      <div className="confirm-card stale">
        <Badge color="warning">失效保留</Badge><strong>{leader}</strong>
        <small>原基于 V{stale.baseVersion} 提交「{stale.decision}」，提交时范围已变化：</small>
        <em>{stale.scopeChangeNote}</em>
        <Field label="按最新范围的处置">
          <Dropdown value={decision} selectedOptions={[decision]} onOptionSelect={(_, data) => setDecision(data.optionValue as DispositionDecision)}>{DECISIONS.map((item) => <Option key={item} value={item}>{item}</Option>)}</Dropdown>
        </Field>
        <Input placeholder="处置说明" value={note} onChange={(_, data) => setNote(data.value)} />
        <Button size="small" appearance="primary" onClick={() => { dispatch(rebaseDisposition({ caseId: recallCase.id, leader, decision, note: note || `按V${recallCase.scopeVersion}重新确认` })); setNote('') }}>按 V{recallCase.scopeVersion} 重新确认（保留原记录）</Button>
      </div>
    )
  }
  return (
    <div className="confirm-card">
      <strong>{leader}</strong>
      <small>打开确认时基准：<b>V{baseVersion}</b>（当前范围 V{recallCase.scopeVersion}）{baseVersion !== recallCase.scopeVersion && <em className="warn-text">范围已变化，提交将被标记失效</em>}</small>
      <Dropdown value={decision} selectedOptions={[decision]} onOptionSelect={(_, data) => setDecision(data.optionValue as DispositionDecision)}>{DECISIONS.map((item) => <Option key={item} value={item}>{item}</Option>)}</Dropdown>
      <Textarea rows={2} placeholder="处置说明（拦截范围/数量）" value={note} onChange={(_, data) => setNote(data.value)} />
      <div className="confirm-actions">
        <Button size="small" appearance="subtle" onClick={() => setBaseVersion(recallCase.scopeVersion)}>同步基准到 V{recallCase.scopeVersion}</Button>
        <Button size="small" appearance="primary" onClick={() => dispatch(submitDisposition({ caseId: recallCase.id, leader, decision, note: note || `按V${baseVersion}范围完成处置`, baseVersion }))}>提交确认</Button>
      </div>
    </div>
  )
}

function DrillPanel({ recallCase, state, dispatch, runFailed }: { recallCase: RecallCase; state: RootState['recall']; dispatch: AppDispatch; runFailed: boolean }) {
  const pendingCount = useMemo(() => {
    const run = recallCase.generationRunId ? state.runs.find((item) => item.id === recallCase.generationRunId) : undefined
    return run?.pendingKeys.length ?? 0
  }, [state.runs, recallCase.generationRunId])

  return (
    <div className="record-panel side-panel drill-panel">
      <div className="record-title"><div><span>演练控制</span><h2>写入失败与恢复</h2></div></div>
      <p className="side-text">注入故障后重跑动作生成：过半动作处模拟写入失败，已入账动作保留，未完成批次可一键恢复，恢复时已确认结果不会重复生成。</p>
      <div className="record-actions" style={{ flexWrap: 'wrap' }}>
        <Button appearance="subtle" onClick={() => dispatch(armWriteFault({ caseId: recallCase.id, operator: '演练员' }))}>① 注入写入故障</Button>
        <Button appearance="secondary" disabled={runFailed} onClick={() => dispatch(regenerateActions({ caseId: recallCase.id, operator: '质量主管 秦岚' }))}>② 重跑动作生成</Button>
      </div>
      {runFailed && <small className="warn-text">运行失败：{pendingCount} 项未完成，请点击上方「恢复未完成批次」条带中的按钮。</small>}
    </div>
  )
}

function RecallAudit({ recallCase, state }: WorkspaceProps) {
  const entries = state.audit.filter((entry) => entry.caseId === recallCase.id).slice(0, 12)
  return (
    <div className="record-panel side-panel">
      <div className="record-title"><div><span>召回审计</span><h2>同一版本口径</h2></div></div>
      <div className="recall-audit-list">
        {entries.map((entry) => (
          <div key={entry.id} className="recall-audit-item">
            <div><Badge appearance="outline">V{entry.recallVersion ?? '-'}</Badge><small>{entry.createdAt.slice(5, 16).replace('T', ' ')}</small></div>
            <strong>{entry.action}</strong><span>{entry.detail}</span><small>{entry.operator}</small>
          </div>
        ))}
      </div>
    </div>
  )
}
