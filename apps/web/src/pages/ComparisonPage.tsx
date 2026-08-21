import { ExportOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Space, Table } from "antd";
import { useMemo, useState } from "react";

import { useApiData } from "../api/client.ts";
import type { ComparisonRow } from "../api/types.ts";
import { PageToolbar } from "../components/PageToolbar.tsx";
import { fallbackComparisons } from "../data/api-fallbacks.ts";
import { formatFen } from "../data/demo-data.ts";
import { buildComparisonCsv, filterComparisons } from "../features/operations/table-tools.ts";

function money(value: number | null) {
  return value === null ? "--" : formatFen(value);
}

export function ComparisonPage({ type }: { type: "BARE" | "BUNDLE" }) {
  const [query, setQuery] = useState("");
  const fallback = type === "BARE" ? fallbackComparisons : fallbackComparisons.slice(0, 2).map((row, index) => ({
    ...row,
    id: `b${index + 1}`,
    model: index === 0 ? "RME Babyface Pro FS + MK4" : "RME Babyface Pro FS + MK8",
    sku: index === 0 ? "同配置录音套装" : "不同核心配置 / 人工核对"
  }));
  const { data, error, refresh } = useApiData<ComparisonRow[]>(`/api/operations/comparisons?type=${type}`, fallback);
  const visibleRows = useMemo(() => filterComparisons(data, query), [data, query]);

  function exportRows() {
    const blob = new Blob(["\uFEFF", buildComparisonCsv(visibleRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `天猫${type === "BARE" ? "裸机" : "套装"}比价_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return <>
    <PageToolbar
      title={type === "BARE" ? "裸机价格排行" : "套装价格排行"}
      description={type === "BARE" ? "仅比较同品牌、同型号、同版本的具体 SKU 到手价。" : "同核心配置直接比总价，不同配置只作人工核对。"}
      actions={<Space><Button icon={<ReloadOutlined />} onClick={() => void refresh()}>刷新数据</Button><Button icon={<ExportOutlined />} disabled={visibleRows.length === 0} onClick={exportRows}>导出</Button></Space>}
    />
    {error ? <Alert className="data-warning" type="warning" showIcon message="比价数据暂时无法刷新" description={error} /> : null}
    <section className="panel table-panel">
      <div className="table-tools">
        <Input.Search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索型号、SKU或同行店铺" allowClear />
      </div>
      <Table
        rowKey="id"
        dataSource={visibleRows}
        scroll={{ x: 880 }}
        columns={[
          { title: "型号", dataIndex: "model", width: 220, render: (value) => <strong>{value}</strong> },
          { title: "具体SKU", dataIndex: "sku", width: 210 },
          { title: "我方到手价", dataIndex: "ownPriceFen", width: 130, align: "right", render: money },
          { title: "同行最低价", dataIndex: "competitorPriceFen", width: 130, align: "right", render: (value) => <span className="risk-price">{money(value)}</span> },
          { title: "价差", width: 100, align: "right", render: (_, row) => <span className="risk-price">{row.ownPriceFen === null || row.competitorPriceFen === null ? "--" : `-${formatFen(row.ownPriceFen - row.competitorPriceFen)}`}</span> },
          { title: "同行店铺", dataIndex: "competitorShop", width: 170 },
          { title: "库存", dataIndex: "stock", width: 90 },
          { title: "更新时间", dataIndex: "updatedAt", width: 170, render: (value) => new Date(value).toLocaleString("zh-CN", { hour12: false }) }
        ]}
      />
    </section>
  </>;
}
