import { Table, Tag, type TableColumnsType } from "antd";

import type { CollectionRunConfirmedLow, CollectionRunOwnSnapshotSummary } from "../../api/types.ts";
import { formatFen } from "../../data/demo-data.ts";

interface ConfirmedLowsSectionProps {
  rows: CollectionRunConfirmedLow[];
}

const BUSINESS_SCROLL = { x: 1_680 } as const;

function priceText(value: number | null): string {
  return value === null ? "未确认" : formatFen(value);
}

function FullUrl({ url }: { url: string }) {
  return <a className="run-business-url" href={url} target="_blank" rel="noreferrer">{url}</a>;
}

function OwnLink({ snapshot, label }: { snapshot: CollectionRunOwnSnapshotSummary; label: string }) {
  return <div className="run-business-facts">
    <strong>{label} {priceText(snapshot.prices.payableFen)}</strong>
    <span>{snapshot.skuText ?? "未标注 SKU"}</span>
    <FullUrl url={snapshot.url} />
  </div>;
}

function AlternativeLinks({ snapshots }: { snapshots: CollectionRunOwnSnapshotSummary[] }) {
  return snapshots.length > 0
    ? <div className="run-business-link-list">{snapshots.map((snapshot) => <OwnLink key={snapshot.id} snapshot={snapshot} label="备用" />)}</div>
    : <span className="run-business-muted">无备用我方链接</span>;
}

const columns: TableColumnsType<CollectionRunConfirmedLow> = [
  {
    title: "同行商品 / 排名",
    width: 370,
    render: (_value, row) => <div className="run-business-facts">
      <strong>店铺：{row.competitorSnapshot.shopName}</strong>
      <span>排名 {row.ranks.join("、")}</span>
      <span>{row.competitorSnapshot.title}</span>
      <FullUrl url={row.competitorSnapshot.url} />
    </div>
  },
  {
    title: "同行 SKU / 活动",
    width: 270,
    render: (_value, row) => <div className="run-business-facts">
      <strong>{row.competitorSnapshot.skuText ?? "未标注 SKU"}</strong>
      {row.competitorSnapshot.promotions.length > 0
        ? row.competitorSnapshot.promotions.map((promotion, index) => <span key={`${promotion.kind}-${index}`}>{promotion.label}</span>)
        : <span>无活动</span>}
      <span>到手 {priceText(row.competitorSnapshot.prices.payableFen)}</span>
      <Tag color={row.competitorSnapshot.stockState === "IN_STOCK" ? "success" : "warning"}>
        {row.competitorSnapshot.stockState === "IN_STOCK" ? "有库存" : row.competitorSnapshot.stockState === "OUT_OF_STOCK" ? "无库存" : "库存未知"}
      </Tag>
    </div>
  },
  { title: "组合", width: 220, render: (_value, row) => <div className="run-business-facts"><strong>{row.combinationLabel ?? "组合待复核"}</strong><span>{row.combinationSignature ?? "无组合签名"}</span></div> },
  { title: "选定我方基准", width: 340, render: (_value, row) => <OwnLink snapshot={row.selectedOwnSnapshot} label="我方" /> },
  { title: "其他我方链接", width: 360, render: (_value, row) => <AlternativeLinks snapshots={row.alternativeOwnSnapshots} /> },
  { title: "价差", width: 120, render: (_value, row) => <Tag color="error">低 {formatFen(row.differenceFen)}</Tag> }
];

export function ConfirmedLowsSection({ rows }: ConfirmedLowsSectionProps) {
  return <section className="panel table-panel run-business-section" aria-labelledby="confirmed-lows-heading">
    <div className="panel-heading"><h2 id="confirmed-lows-heading">确认低价同行</h2><span>{rows.length} 个 SKU</span></div>
    <div className="run-business-table-scroll collection-runs-scroll">
      <Table<CollectionRunConfirmedLow>
        columns={columns}
        dataSource={rows}
        locale={{ emptyText: "暂无确认低价同行" }}
        pagination={false}
        rowKey={(row) => row.competitorSnapshot.id}
        scroll={BUSINESS_SCROLL}
        size="small"
      />
    </div>
  </section>;
}
