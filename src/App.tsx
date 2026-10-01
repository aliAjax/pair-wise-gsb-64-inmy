import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Badge, Button } from '@fluentui/react-components'
import { BrowserRouter } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from './store'
import { resetDemo } from './store/haccpSlice'
import { resetRecallDemo } from './recall/recallSlice'
import { Overview } from './views/Overview'
import { ProcessControl } from './views/ProcessControl'
import { DeviationWorkbench } from './views/DeviationWorkbench'
import { AuditTrail } from './views/AuditTrail'
import { RecallCenter } from './recall/RecallCenter'

const navigation = [
  ['/', '生产批次'],
  ['/recall', '召回行动'],
  ['/process', 'HACCP控制矩阵'],
  ['/deviations', '偏差调查'],
  ['/audit', '追溯审计']
]

function Shell() {
  const dispatch = useDispatch<AppDispatch>()
  const openDeviations = useSelector((state: RootState) => state.haccp.deviations.filter((item) => item.status !== '已关闭').length)
  const openRecallDeviations = useSelector((state: RootState) => state.recall.deviations.filter((item) => item.status === 'open').length)
  const recallCount = useSelector((state: RootState) => state.recall.cases.length)
  return (
    <div className="app-shell">
      <aside>
        <div className="brand"><b>H</b><div><strong>食品安全控制台</strong><small>HACCP批次与偏差追溯</small></div></div>
        <nav>{navigation.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>
          <span>{label}</span>
          {label === '偏差调查' && openDeviations > 0 && <Badge appearance="filled" color="danger">{openDeviations}</Badge>}
          {label === '召回行动' && (openRecallDeviations > 0 || recallCount > 0) && <Badge appearance="filled" color="danger">{openRecallDeviations}</Badge>}
        </NavLink>)}</nav>
        <div className="aside-note"><strong>生产日</strong><span>2026-10-01</span><small>数据源：本地持久化</small></div>
      </aside>
      <main>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/recall" element={<RecallCenter />} />
          <Route path="/process" element={<ProcessControl />} />
          <Route path="/deviations" element={<DeviationWorkbench />} />
          <Route path="/audit" element={<AuditTrail />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Button className="reset-button" appearance="subtle" onClick={() => { dispatch(resetDemo()); dispatch(resetRecallDemo()) }}>恢复演示数据</Button>
      </main>
    </div>
  )
}

export function App() {
  return <BrowserRouter><Shell /></BrowserRouter>
}
