/**
 * Resource-table snapshots of one day (original ResourceSnapshotTable): each instance's first vs latest snapshot and
 * the full list.
 *
 * ★ Precision: the in-game 「道具 → 资源统计」 table only shows 0.1亿 (1000 万), so every amount is shown with ≈,
 *   a change below that precision is ≈0, and the 「变化」 column is reconciliation only — the daily amount is the
 *   page's 预计采集量 (dispatch bookkeeping). The notice at the top says so.
 */
import { useMemo, useState } from 'react';
import { RESOURCE_NAME, RESOURCE_PANEL_ROW_ORDER, snapshotRow, type ResourceSnapshot } from '@avdm/automation/wanlong/pure';
import { Icon } from '../../components/Icon';
import { SemanticTag } from '../../components/SemanticTag';
import { formatCstClock } from '../../format';
import { SNAPSHOT_PAGE_SIZE, amountView, compareRows, deltaView, pageOf } from './stats-model';

export interface ResourceSnapshotTableProps {
  snapshots: readonly ResourceSnapshot[];
  /** Name shown for an instance: 「实例 N「账号」」. */
  who: (instanceIndex: number) => string;
}

function AmountCell({ value, raw }: { value: number | null; raw: string }) {
  const view = amountView(value, raw);
  return <span className={view.dim ? 'stats-dim' : 'stats-mono'} title={view.title}>{view.text}</span>;
}

function DeltaCell({ from, to }: { from: number | null; to: number | null }) {
  const view = deltaView(from, to);
  if (view.kind === 'none') return <span className="stats-dim">—</span>;
  if (view.kind === 'flat') return <span className="stats-dim" title={view.title}>≈0</span>;
  return <span className={`stats-mono ${view.kind === 'up' ? 'stats-delta-up' : 'stats-delta-down'}`}>{view.text}</span>;
}

export function ResourceSnapshotTable({ snapshots, who }: ResourceSnapshotTableProps) {
  const rows = useMemo(() => compareRows(snapshots), [snapshots]);
  const sorted = useMemo(() => snapshots.slice().sort((a, b) => a.at - b.at), [snapshots]);
  const [page, setPage] = useState(1);
  const paged = pageOf(sorted, page, SNAPSHOT_PAGE_SIZE);
  const span = RESOURCE_PANEL_ROW_ORDER.length;

  return (
    <div className="stats-snapshots">
      <div className="notice info stats-precision" role="note">
        <Icon name="info" />
        <div>
          <strong>精度 0.1亿（1000 万），仅作对账参考</strong>
          <p>
            这张表读的是游戏「道具 → 资源统计」弹窗，一趟魔水只有 42 万，差值会被四舍五入整个吞掉。日采集量以上方「预计采集量」
            （派兵时读到的卡片储量）为准；这里的「变化」只用来发现资源被大量消耗或有采集以外的进项。
          </p>
        </div>
      </div>

      <div className="stats-subsection">
        <h3 className="stats-subtitle">日初 / 最近 对比（每实例当天最早与最近两张快照）</h3>
        <div className="table-wrap stats-table-scroll">
          <table className="inst-table stats-table">
            <thead>
              <tr>
                <th scope="col">实例</th>
                <th scope="col">资源</th>
                <th scope="col" className="stats-right">日初资源总量</th>
                <th scope="col" className="stats-right">最近资源总量</th>
                <th scope="col" className="stats-right">最近道具总量</th>
                <th scope="col" className="stats-right">变化</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  {row.firstOfInstance && (
                    <td rowSpan={span} className="stats-instance-cell">
                      <div>{who(row.instanceIndex)}</div>
                      <div className="stats-micro">
                        {row.same ? `只有 1 张（${formatCstClock(row.firstAt)}）` : `${formatCstClock(row.firstAt)} → ${formatCstClock(row.lastAt)}`}
                      </div>
                    </td>
                  )}
                  <td>{RESOURCE_NAME[row.type]}</td>
                  <td className="stats-right"><AmountCell value={row.firstTotal} raw={row.rawFirstTotal} /></td>
                  <td className="stats-right"><AmountCell value={row.lastTotal} raw={row.rawLastTotal} /></td>
                  <td className="stats-right"><AmountCell value={row.lastItem} raw={row.rawLastItem} /></td>
                  <td className="stats-right">{row.same ? <span className="stats-dim">—</span> : <DeltaCell from={row.firstTotal} to={row.lastTotal} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="stats-subsection">
        <h3 className="stats-subtitle">全部快照（{sorted.length} 张，按时间升序）</h3>
        <div className="table-wrap stats-table-scroll">
          <table className="inst-table stats-table stats-table-wide">
            <thead>
              <tr>
                <th scope="col">时间（北京）</th>
                <th scope="col">实例</th>
                {RESOURCE_PANEL_ROW_ORDER.map((type) => <th key={type} scope="col" className="stats-right">{RESOURCE_NAME[type]}</th>)}
                <th scope="col">说明</th>
              </tr>
            </thead>
            <tbody>
              {paged.rows.map((snap) => (
                <tr key={`${snap.instanceIndex}-${snap.at}`}>
                  <td className="stats-mono">{formatCstClock(snap.at)}</td>
                  <td>{who(snap.instanceIndex)}</td>
                  {RESOURCE_PANEL_ROW_ORDER.map((type) => {
                    const row = snapshotRow(snap, type);
                    return (
                      <td key={type} className="stats-right">
                        <div className="stats-stack">
                          <span><span className="stats-micro">资源 </span><AmountCell value={row?.total ?? null} raw={row?.rawTotal ?? ''} /></span>
                          <span><span className="stats-micro">道具 </span><AmountCell value={row?.itemTotal ?? null} raw={row?.rawItem ?? ''} /></span>
                        </div>
                      </td>
                    );
                  })}
                  <td>
                    {snap.warnings.length === 0
                      ? <SemanticTag tone="success">干净</SemanticTag>
                      : <SemanticTag tone="warning" title={snap.warnings.join('；')}>{snap.warnings.length} 条降级</SemanticTag>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {paged.pages > 1 && (
          <nav className="stats-pager" aria-label="快照分页">
            <button type="button" className="btn xs" disabled={paged.page <= 1} onClick={() => setPage(paged.page - 1)}>上一页</button>
            <span className="stats-micro">第 {paged.page} / {paged.pages} 页</span>
            <button type="button" className="btn xs" disabled={paged.page >= paged.pages} onClick={() => setPage(paged.page + 1)}>下一页</button>
          </nav>
        )}
      </div>
    </div>
  );
}
