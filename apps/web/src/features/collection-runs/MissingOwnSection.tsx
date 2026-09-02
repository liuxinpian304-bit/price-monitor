import { Table, Tag, type TableColumnsType } from "antd";

import type { CollectionRunMissingOwnGroup, CollectionRunReportSku } from "../../api/types.ts";
import { formatFen } from "../../data/demo-data.ts";

interface MissingOwnSectionProps {
  groups: CollectionRunMissingOwnGroup[];
}

const BUSINESS_SCROLL = { x: 1_520 } as const;
const NO_ALERT_EXPLANATION = "无同组合我方基准，不属于低价告警";

function priceText(value: number | null): string {
  return value === null ? "未确认" : formatFen(value);
}

function FullUrl({ url }: { url: string }) {
  return <a className="run-business-url" href={url} target="_blank" rel="noreferrer">{url}</a>;
}

function Offer({ offer }: { offer: CollectionRunReportSku }) {
  return <div className="run-business-offer">
    <div className="run-business-facts">
      <strong>{offer.shopName} · {offer.skuText ?? "未标注 SKU"}</strong>
      <span>{offer.ranks.length > 0 ? `排名 ${offer.ranks.join("、")}` : "非搜索位"}</span>
      <span>活动 {priceText(offer.prices.activityPriceFen)} · 到手 {priceText(offer.prices.payableFen)}</span>
      <span>{offer.stockState === "IN_STOCK" ? "有库存" : offer.stockState === "OUT_OF_STOCK" ? "无库存" : "库存未知"}</span>
      <FullUrl url={offer.url} />
    </div>
  </div>;
}

function Offers({ offers }: { offers: CollectionRunReportSku[] }) {
  return <div className="run-business-link-list">{offers.map((offer) => <Offer key={offer.id} offer={offer} />)}</div>;
}

const columns: TableColumnsType<CollectionRunMissingOwnGroup> = [
  {
    title: "缺失组合",
    width: 320,
    render: (_value, group) => <div className="run-business-facts">
      <strong>{group.combinationLabel}</strong>
      <span>{group.combinationSignature}</span>
      <span>最早排名 {group.earliestRank}</span>
    </div>
  },
  {
    title: "缺失原因",
    width: 300,
    render: (_value, group) => <div className="run-business-facts">
      <Tag color={group.missingReason === "OWN_OUT_OF_STOCK_ONLY" ? "warning" : "default"}>
        {group.missingReason === "OWN_OUT_OF_STOCK_ONLY" ? "我方有组合但当前无库存" : "我方无同组合"}
      </Tag>
      <strong>{NO_ALERT_EXPLANATION}</strong>
    </div>
  },
  {
    title: "最低确认来源",
    width: 260,
    render: (_value, group) => <div className="run-business-facts">
      <strong>{priceText(group.minimumConfirmedPayableFen)}</strong>
      <span>{group.minimumOfferRank === null ? "排名未确认" : `排名 ${group.minimumOfferRank}`}</span>
      <span>{group.minimumOfferSnapshotId ?? "来源未确认"}</span>
    </div>
  },
  { title: "涉及店铺", width: 240, render: (_value, group) => group.shops.join("、") },
  { title: "同行商品 / SKU / 活动 / 库存", width: 500, render: (_value, group) => <Offers offers={group.offers} /> }
];

export function MissingOwnSection({ groups }: MissingOwnSectionProps) {
  return <section className="panel table-panel run-business-section" aria-labelledby="missing-own-heading">
    <div className="panel-heading"><h2 id="missing-own-heading">我方缺失组合</h2><span>{groups.length} 个组合</span></div>
    <div className="run-business-table-scroll collection-runs-scroll">
      <Table<CollectionRunMissingOwnGroup>
        columns={columns}
        dataSource={groups}
        locale={{ emptyText: "暂无我方缺失组合" }}
        pagination={false}
        rowKey="combinationSignature"
        scroll={BUSINESS_SCROLL}
        size="small"
      />
    </div>
  </section>;
}
