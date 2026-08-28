import { DownOutlined, RightOutlined } from "@ant-design/icons";
import { Button, Table, Tag, Tooltip, type TableColumnsType, type TableProps } from "antd";
import { useMemo } from "react";

import type {
  CollectionRunBusinessItemGroup,
  CollectionRunOwnSnapshotSummary,
  CollectionRunReportSku,
  CollectionRunShopGroup
} from "../../api/types.ts";
import { formatFen } from "../../data/demo-data.ts";

interface PriceBoardSectionProps {
  shops: CollectionRunShopGroup[];
}

interface ExpandedSkuRow {
  key: string;
  item: CollectionRunBusinessItemGroup;
  sku: CollectionRunReportSku | null;
}

const BUSINESS_SCROLL = { x: 1_360 } as const;
const EXPANDED_SCROLL = { x: 1_680 } as const;

function priceText(value: number | null): string {
  return value === null ? "未确认" : formatFen(value);
}

function ranksText(ranks: number[]): string {
  return ranks.length > 0 ? `排名 ${ranks.join("、")}` : "非搜索位";
}

function stockTag(stockState: CollectionRunReportSku["stockState"]) {
  const label = stockState === "IN_STOCK" ? "有库存" : stockState === "OUT_OF_STOCK" ? "无库存" : "库存未知";
  return <Tag color={stockState === "IN_STOCK" ? "success" : stockState === "UNKNOWN" ? "warning" : "default"}>{label}</Tag>;
}

function FullUrl({ url }: { url: string }) {
  return <a className="run-business-url" href={url} target="_blank" rel="noreferrer">{url}</a>;
}

function PriceActivity({ row }: { row: CollectionRunReportSku }) {
  return <div className="run-business-facts">
    <span>标价 {priceText(row.prices.listPriceFen)}</span>
    <span>活动 {priceText(row.prices.activityPriceFen)}</span>
    {row.promotions.length > 0
      ? row.promotions.map((promotion, index) => <span key={`${promotion.kind}-${promotion.label}-${index}`}>{promotion.label}</span>)
      : <span>无活动</span>}
    <strong>到手 {priceText(row.prices.payableFen)}</strong>
  </div>;
}

function OwnSnapshot({ snapshot, prefix }: { snapshot: CollectionRunOwnSnapshotSummary; prefix: string }) {
  return <div className="run-business-facts">
    <strong>{prefix} {priceText(snapshot.prices.payableFen)}</strong>
    <span>{snapshot.skuText ?? "未标注 SKU"}</span>
    <FullUrl url={snapshot.url} />
  </div>;
}

function AlternativeOwnSnapshots({ snapshots }: { snapshots: CollectionRunOwnSnapshotSummary[] }) {
  if (snapshots.length === 0) return <span className="run-business-muted">无备用我方链接</span>;
  return <div className="run-business-link-list">
    {snapshots.map((snapshot) => <OwnSnapshot key={snapshot.id} snapshot={snapshot} prefix="备用" />)}
  </div>;
}

const expandedColumns: TableColumnsType<ExpandedSkuRow> = [
  {
    title: "排名 / 商品",
    width: 340,
    render: (_value, row) => <div className="run-business-facts">
      <strong>{ranksText(row.item.ranks)}</strong>
      <span>{row.item.title}</span>
      <FullUrl url={row.item.url} />
    </div>
  },
  {
    title: "SKU / 组合",
    width: 230,
    render: (_value, row) => row.sku ? <div className="run-business-facts">
      <strong>{row.sku.skuText ?? "未标注 SKU"}</strong>
      <span>{row.sku.skuId ?? "无 SKU ID"}</span>
      <span>{row.sku.combination.label ?? "组合待复核"}</span>
    </div> : <span className="run-business-muted">未采集 SKU</span>
  },
  { title: "活动 / 到手价", width: 260, render: (_value, row) => row.sku ? <PriceActivity row={row.sku} /> : "--" },
  { title: "库存", width: 110, render: (_value, row) => row.sku ? stockTag(row.sku.stockState) : "--" },
  {
    title: "选定我方基准",
    width: 330,
    render: (_value, row) => row.sku?.selectedOwnSnapshot
      ? <OwnSnapshot snapshot={row.sku.selectedOwnSnapshot} prefix="我方" />
      : <span className="run-business-muted">无同组合我方基准</span>
  },
  { title: "其他我方链接", width: 410, render: (_value, row) => <AlternativeOwnSnapshots snapshots={row.sku?.alternativeOwnSnapshots ?? []} /> }
];

function ExpandedShopItems({ shop }: { shop: CollectionRunShopGroup }) {
  const rows = useMemo<ExpandedSkuRow[]>(() => {
    const expandedRows: ExpandedSkuRow[] = [];
    for (const item of shop.items) {
      if (item.skus.length === 0) {
        expandedRows.push({ key: `${item.platformItemId}-no-sku`, item, sku: null });
        continue;
      }
      for (const sku of item.skus) {
        expandedRows.push({ key: `${item.platformItemId}-${sku.id}`, item, sku });
      }
    }
    return expandedRows;
  }, [shop.items]);

  return <Table<ExpandedSkuRow>
    className="run-business-expanded-table"
    columns={expandedColumns}
    dataSource={rows}
    locale={{ emptyText: "该店铺暂无商品 SKU" }}
    pagination={false}
    scroll={EXPANDED_SCROLL}
    size="small"
  />;
}

function shopExpandIcon({ expanded, onExpand, record }: Parameters<NonNullable<NonNullable<TableProps<CollectionRunShopGroup>["expandable"]>["expandIcon"]>>[0]) {
  const label = `${expanded ? "收起" : "展开"}店铺 ${record.shopName}`;
  return <Tooltip title={label}>
    <Button
      aria-label={label}
      icon={expanded ? <DownOutlined /> : <RightOutlined />}
      onClick={(event) => onExpand(record, event)}
      size="small"
      type="text"
    />
  </Tooltip>;
}

const shopColumns: TableColumnsType<CollectionRunShopGroup> = [
  { title: "店铺", dataIndex: "shopName", width: 300 },
  { title: "搜索排名", width: 220, render: (_value, shop) => ranksText(shop.ranks) },
  { title: "位置", dataIndex: "positionCount", width: 100 },
  { title: "商品", dataIndex: "itemCount", width: 100 },
  { title: "SKU", dataIndex: "skuCount", width: 100 },
  { title: "最低确认到手价", width: 180, render: (_value, shop) => priceText(shop.minimumConfirmedPayableFen) },
  { title: "确认低价", dataIndex: "confirmedLowCount", width: 140 },
  { title: "缺失组合", dataIndex: "missingCombinationCount", width: 140 }
];

const shopExpandable: NonNullable<TableProps<CollectionRunShopGroup>["expandable"]> = {
  expandIcon: shopExpandIcon,
  expandedRowRender: (shop) => <ExpandedShopItems shop={shop} />,
  rowExpandable: (shop) => shop.items.length > 0
};

export function PriceBoardSection({ shops }: PriceBoardSectionProps) {
  return <section className="panel table-panel run-business-section" aria-labelledby="price-board-heading">
    <div className="panel-heading">
      <h2 id="price-board-heading">前 50 价盘</h2>
      <span>{shops.length} 家店铺，按服务端顺序</span>
    </div>
    <div className="run-business-table-scroll collection-runs-scroll">
      <Table<CollectionRunShopGroup>
        columns={shopColumns}
        dataSource={shops}
        expandable={shopExpandable}
        locale={{ emptyText: "暂无价盘数据" }}
        pagination={false}
        rowKey="shopName"
        scroll={BUSINESS_SCROLL}
        size="small"
      />
    </div>
  </section>;
}
