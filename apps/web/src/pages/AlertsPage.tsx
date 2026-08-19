import { Alert, Button, Input, Table, Tabs } from "antd";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useApiData } from "../api/client.ts";
import type { ApiAlert } from "../api/types.ts";
import { PageToolbar } from "../components/PageToolbar.tsx";
import { StatusText } from "../components/StatusText.tsx";
import { fallbackAlerts } from "../data/api-fallbacks.ts";
import { formatFen } from "../data/demo-data.ts";
import { filterAlerts, formatDateTime } from "../features/operations/table-tools.ts";

function money(value: number | null) {
  return value === null ? "--" : formatFen(value);
}

function AlertTable({ data }: { data: ApiAlert[] }) {
  return <Table
    rowKey="id"
    dataSource={data}
    scroll={{ x: 960 }}
    columns={[
      { title: "型号", dataIndex: "model", width: 240, render: (model: string, row) => <Link to={`/alerts/${row.id}`} className="model-link">{model}</Link> },
      { title: "具体SKU", dataIndex: "sku", width: 200 },
      { title: "我方到手价", dataIndex: "ownPriceFen", width: 125, align: "right", render: formatFen },
      { title: "同行最低价", dataIndex: "competitorPriceFen", width: 125, align: "right", render: (value) => <span className="risk-price">{money(value)}</span> },
      { title: "价差", dataIndex: "differenceFen", width: 100, align: "right", render: (value) => <span className="risk-price">{value === null ? "--" : `-${formatFen(value)}`}</span> },
      { title: "同行店铺", dataIndex: "competitorShop", width: 170 },
      { title: "发现时间", dataIndex: "foundAt", width: 180, render: formatDateTime },
      { title: "状态", dataIndex: "status", width: 100, render: (status) => <StatusText status={status} /> },
      { title: "操作", width: 90, render: (_, row) => <Link to={`/alerts/${row.id}`}><Button type="link">处理</Button></Link> }
    ]}
  />;
}

export function AlertsPage() {
  const [query, setQuery] = useState("");
  const { data: alerts, error } = useApiData<ApiAlert[]>("/api/alerts", fallbackAlerts);
  const visibleAlerts = useMemo(() => filterAlerts(alerts, query), [alerts, query]);
  const bare = visibleAlerts.filter((alert) => alert.type === "BARE");
  const bundle = visibleAlerts.filter((alert) => alert.type === "BUNDLE");
  return <>
    <PageToolbar
      title="低价预警"
      description="系统只提醒和记录，不自动修改天猫价格。"
      actions={<Input.Search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索型号、SKU或同行店铺" allowClear />}
    />
    {error ? <Alert className="data-warning" type="warning" showIcon message="预警数据暂时无法刷新" description={error} /> : null}
    <section className="panel tab-panel">
      <Tabs items={[
        { key: "bare", label: `裸机预警 ${bare.length}`, children: <AlertTable data={bare} /> },
        { key: "bundle", label: `套装预警 ${bundle.length}`, children: <AlertTable data={bundle} /> }
      ]} />
    </section>
  </>;
}
