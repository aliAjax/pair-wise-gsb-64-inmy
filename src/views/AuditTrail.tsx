import { useState } from 'react'
import { Badge, Button, Input, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import { useSelector } from 'react-redux'
import type { RootState } from '../store'

interface UnifiedRow {
  id: string
  createdAt: string
  scope: string
  entity: string
  action: string
  operator: string
  detail: string
  recallVersion: number | null
}

export function AuditTrail() {
  const haccp = useSelector((root: RootState) => root.haccp)
  const recall = useSelector((root: RootState) => root.recall)
  const [keyword, setKeyword] = useState('')

  // 批次、偏差、审计统一显示召回版本：HACCP 事件无召回版本，召回事件带 V 版本号
  const rows: UnifiedRow[] = [
    ...haccp.audit.map((entry) => ({ ...entry, scope: 'HACCP', recallVersion: null })),
    ...recall.audit.map((entry) => ({ id: entry.id, createdAt: entry.createdAt, scope: '召回', entity: entry.caseId ?? '全局', action: entry.action, operator: entry.operator, detail: entry.detail, recallVersion: entry.recallVersion }))
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const filtered = rows.filter((item) => `${item.scope} ${item.entity} ${item.action} ${item.operator} ${item.detail}`.includes(keyword))
  const exportAudit = () => {
    const pack = {
      exportedAt: new Date().toISOString(),
      recallCases: recall.cases.map((recallCase) => ({
        caseId: recallCase.id,
        noticeNo: recallCase.noticeNo,
        scopeVersion: recallCase.scopeVersion,
        snapshots: recallCase.snapshots,
        scopeNodes: recallCase.scopeNodes,
        confirmations: recallCase.confirmations,
        deviations: recall.deviations.filter((deviation) => deviation.caseId === recallCase.id),
        actionLedger: recall.actionLedger.filter((entry) => entry.caseId === recallCase.id),
        runs: recall.runs.filter((run) => run.caseId === recallCase.id)
      })),
      events: rows
    }
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'HACCP召回追溯包.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  return <section className="page"><header className="page-head"><div><p>批次 / 控制点 / 偏差 / 召回 / 签字</p><h1>完整追溯审计</h1></div><Button appearance="primary" onClick={exportAudit}>导出追溯包</Button></header>
    <div className="toolbar"><Input value={keyword} onChange={(_, data) => setKeyword(data.value)} placeholder="搜索实体、动作、操作人" /><span>共{filtered.length}条事件；召回事件携带统一召回版本号</span></div>
    <div className="table-panel"><Table size="small"><TableHeader><TableRow><TableHeaderCell>时间</TableHeaderCell><TableHeaderCell>域</TableHeaderCell><TableHeaderCell>召回版本</TableHeaderCell><TableHeaderCell>实体</TableHeaderCell><TableHeaderCell>动作</TableHeaderCell><TableHeaderCell>操作人</TableHeaderCell><TableHeaderCell>说明</TableHeaderCell></TableRow></TableHeader><TableBody>{filtered.map((item) => <TableRow key={`${item.scope}-${item.id}`}><TableCell>{item.createdAt.replace('T', ' ').slice(0, 16)}</TableCell><TableCell><Badge appearance="tint" color={item.scope === '召回' ? 'danger' : 'informative'}>{item.scope}</Badge></TableCell><TableCell>{item.recallVersion === null ? <span className="muted-cell">—</span> : <b>V{item.recallVersion}</b>}</TableCell><TableCell>{item.entity}</TableCell><TableCell>{item.action}</TableCell><TableCell>{item.operator}</TableCell><TableCell>{item.detail}</TableCell></TableRow>)}</TableBody></Table></div>
  </section>
}
