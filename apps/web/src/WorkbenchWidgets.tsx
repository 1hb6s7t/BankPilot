import { ArrowLeftRight, ArrowRight, ChevronRight, CircleAlert, FileClock, FileText, PieChart, ShieldCheck } from 'lucide-react';
import type { AccountView, ActionView, FundsPreview, PayeeView } from '../../../packages/contracts/src';
import { transferStatusLabel } from './actionStatus';
import { overviewSegmentWidth, workbenchMoney, workbenchOverviewModel } from './workbenchOverviewModel';
import './WorkbenchWidgets.css';

export type AccountOverviewProps = {
  account?: AccountView;
  preview?: FundsPreview;
  loading?: boolean;
  error?: string;
  stale?: boolean;
  onOpenFunds: () => void;
};

export function AccountOverview({ account, preview, loading, error, stale, onOpenFunds }: AccountOverviewProps) {
  const currentPreview = loading || error || stale ? undefined : preview;
  const model = workbenchOverviewModel(account, currentPreview);
  const allocation = model.allocation;
  const pendingPayment = allocation ? allocation.payment > 0n : false;
  const unavailable = error ? `资金预演暂不可用：${error}`
    : stale ? '账户状态更新中，资金安排将在核对后显示。'
      : loading ? '正在读取资金保护与可用余额…'
        : model.state === 'mismatch' ? '账户与预演数据尚未一致，请刷新后核对。'
          : '选择一笔待确认转账，即可查看本次资金安排。';

  return <section className="wb-overview" aria-label="账户概览" aria-busy={loading || stale || undefined}>
    <div className="wb-section-heading"><h2>账户概览</h2><button className="wb-text-button" onClick={onOpenFunds}>资金规则 <ChevronRight size={14} /></button></div>
    <div className="wb-metrics">
      <div className="wb-metric">
        <span className="wb-metric-label">{account?.name ?? '日常账户'}</span>
        <strong>{model.available !== undefined ? workbenchMoney(model.available) : '—'}</strong>
        <span className="wb-metric-caption">{stale ? '上次可用 · 更新中' : '当前可用'}{account && model.available !== undefined && BigInt(account.reservedMinor) > 0n ? ` · 已占额 ${workbenchMoney(account.reservedMinor)}` : account ? ` · ${account.maskedNumber}` : ' · 等待账户数据'}</span>
      </div>
      <div className="wb-metric">
        <span className="wb-metric-label">资金保护</span>
        <strong>{allocation ? workbenchMoney(allocation.protected) : '—'}</strong>
        <span className="wb-metric-caption">最低保留金额与近期到期义务</span>
      </div>
      <div className="wb-metric">
        <span className="wb-metric-label">{pendingPayment ? '预计转账后' : '预演后可用'}</span>
        <strong>{allocation ? workbenchMoney(allocation.after) : '—'}</strong>
        <span className="wb-metric-caption">{pendingPayment ? `扣除本次 ${workbenchMoney(allocation!.payment)} 后的预计余额` : allocation ? '当前没有预演中的付款' : '待资金预演返回'}</span>
      </div>
    </div>
    {allocation && model.state === 'ready' ? <div className="wb-allocation">
      <span className="wb-allocation-title">{pendingPayment ? '本次计划预演' : '当前资金安排'}<small>{pendingPayment ? '尚未扣款' : '不会自动付款'}</small></span>
      <div className="wb-allocation-content">
        <div className="wb-allocation-bar" role="img" aria-label={`资金保护 ${workbenchMoney(allocation.protected)}，计划转账 ${workbenchMoney(allocation.payment)}，可自由支配 ${workbenchMoney(allocation.remaining)}。这是预演，尚未扣款。`}>
          <span className="wb-bar-protected" style={{ width: overviewSegmentWidth(allocation.protected, allocation.available) }} />
          <span className="wb-bar-payment" style={{ width: overviewSegmentWidth(allocation.payment, allocation.available) }} />
          <span className="wb-bar-remaining" style={{ flex: 1 }} />
        </div>
        <div className="wb-allocation-legend">
          <span><i className="wb-key-protected" />资金保护 <b>{workbenchMoney(allocation.protected)}</b></span>
          <span><i className="wb-key-payment" />计划转账 <b>{workbenchMoney(allocation.payment)}</b></span>
          <span><i className="wb-key-remaining" />可自由支配 <b>{workbenchMoney(allocation.remaining)}</b></span>
        </div>
        <span className="wb-allocation-note">{allocation.available === 0n ? '当前无可分配资金。' : pendingPayment ? '按当前动作预演，尚未扣款。' : '预算保护不会自动付款。'}</span>
      </div>
    </div> : model.state === 'blocked' && allocation ? <div className="wb-overview-state wb-overview-warning" role="status"><CircleAlert size={17} /><span>{allocation.shortfall > 0n ? `本次安排距保护额度还差 ${workbenchMoney(allocation.shortfall)}，请调整金额或资金计划。` : currentPreview?.reasons.join('；') || '本次安排未通过资金保护检查，请查看具体原因。'}</span><button className="wb-text-button" onClick={onOpenFunds}>查看规则 <ArrowRight size={14} /></button></div>
      : <div className={`wb-overview-state ${error || model.state === 'mismatch' ? 'wb-overview-warning' : ''}`} role="status"><ShieldCheck size={17} /><span>{unavailable}</span></div>}
  </section>;
}

export type WorkbenchSupplementProps = {
  actions: ActionView[];
  payees: PayeeView[];
  onOpenAction: (id: string) => void;
  onOpenHistory: () => void;
  onNavigate: (section: '联系人' | '账单' | '资金计划') => void;
};

function recentTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function actionTone(status: ActionView['status']): string {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED') return 'danger';
  if (status === 'CANCELLED' || status === 'EXPIRED') return 'muted';
  return 'pending';
}

export function WorkbenchSupplement({ actions, payees, onOpenAction, onOpenHistory, onNavigate }: WorkbenchSupplementProps) {
  const recent = [...actions].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 3);
  return <div className="wb-supplement">
    <section className="wb-recent" aria-labelledby="wb-recent-title">
      <div className="wb-section-heading"><h2 id="wb-recent-title">近期办理</h2><button className="wb-text-button" onClick={onOpenHistory}>查看全部 <ChevronRight size={14} /></button></div>
      {recent.length ? <div className="wb-table-wrap"><table className="wb-recent-table">
        <thead><tr><th scope="col">事项</th><th scope="col">时间</th><th scope="col">状态</th></tr></thead>
        <tbody>{recent.map(action => <tr key={action.id}>
          <td><button className="wb-recent-link" onClick={() => onOpenAction(action.id)} aria-label={`查看给${action.payeeName}转账${workbenchMoney(action.amountMinor)}的办理记录`}><ArrowLeftRight size={16} /><span>给 {action.payeeName}<small>{workbenchMoney(action.amountMinor)}</small></span></button></td>
          <td><time dateTime={action.createdAt}>{recentTime(action.createdAt)}</time></td>
          <td><span className={`wb-status wb-status-${actionTone(action.status)}`}><i />{transferStatusLabel(action.status)}</span></td>
        </tr>)}</tbody>
      </table></div> : <div className="wb-empty-history"><FileClock size={23} /><div><strong>暂无办理记录</strong><p>提交需求后，真实动作与处理状态会显示在这里。</p></div><button className="wb-text-button" onClick={onOpenHistory}>查看操作记录 <ArrowRight size={14} /></button></div>}
    </section>
    <section className="wb-contacts" aria-labelledby="wb-contacts-title">
      <div className="wb-section-heading"><h2 id="wb-contacts-title">常用联系人</h2><button className="wb-text-button" onClick={() => onNavigate('联系人')}>管理 <ChevronRight size={14} /></button></div>
      <div className="wb-contact-list">
        {payees.slice(0, 3).map((payee, index) => <button className="wb-contact" key={payee.id} onClick={() => onNavigate('联系人')} title={`${payee.name} · ${payee.bank} · ${payee.maskedNumber}`}>
          <span className={`wb-contact-avatar wb-contact-avatar-${index}`} aria-hidden="true">{payee.name.slice(-1)}</span><span>{payee.name}</span>
        </button>)}
        {!payees.length && <p className="wb-contact-empty">暂无已保存的联系人。</p>}
      </div>
      <div className="wb-shortcuts">
        <button onClick={() => onNavigate('账单')}><FileText size={24} /><span><strong>分析账单</strong><small>支出分类与趋势</small></span><ChevronRight size={13} /></button>
        <button onClick={() => onNavigate('资金计划')}><PieChart size={24} /><span><strong>查看资金计划</strong><small>保护预算与可用余额</small></span><ChevronRight size={13} /></button>
      </div>
    </section>
  </div>;
}
