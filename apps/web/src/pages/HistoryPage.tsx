import { Alert, DatePicker, Select, Space, Table } from "antd";
import { useMemo, useState } from "react";

import { useApiData } from "../api/client.ts";
import type { HistoryRow } from "../api/types.ts";
import { PageToolbar } from "../components/PageToolbar.tsx";
import { fallbackHistory } from "../data/api-fallbacks.ts";
import { formatFen } from "../data/demo-data.ts";
import { filterHistory, formatDateTime, type DateRange, type HistoryTypeFilter } from "../features/operations/table-tools.ts";

export function HistoryPage() {
  const [type, setType] = useState<HistoryTypeFilter>("ALL");
  const [dateRange, setDateRange] = useState<DateRange>(null);
  const { data, error } = useApiData<HistoryRow[]>("/api/operations/history", fallbackHistory);
  const visibleRows = useMemo(() => filterHistory(data, type, dateRange), [data, type, dateRange]);
  return <>
    <PageToolbar title="历史价格" description="按具体商品和 SKU 回看每次采集价格与证据。" />
    {error ? <Alert className="data-warning" type="warning" showIcon message="历史价格暂时无法刷新" description={error} /> : null}
    <section className="panel table-panel">
      <div className="table-tools"><Space wrap>
        <DatePicker.RangePicker onChange={(values) => {
          if (!values?.[0] || !values[1]) setDateRange(null);
          else setDateRange([values[0].startOf("day").toDate(), values[1].endOf("day").toDate()]);
        }} />
        <Select<HistoryTypeFilter> value={type} onChange={setType} options={[{ value: "ALL", label: "全部类型" }, { value: "BARE", label: "裸机" }, { value: "BUNDLE", label: "套装" }]} />
      </Space></div>
      <Table rowKey="id" dataSource={visibleRows} scroll={{ x: 980 }} columns={[
        { title: "型号", dataIndex: "model", width: 220 },
        { title: "SKU", dataIndex: "sku", width: 180 },
        { title: "类型", dataIndex: "type", width: 80, render: (value) => value === "BARE" ? "裸机" : "套装" },
        { title: "到手价", dataIndex: "payableFen", align: "right", render: (value) => value === null ? "--" : formatFen(value) },
        { title: "同行店铺", dataIndex: "shop", width: 180 },
        { title: "库存", dataIndex: "stock" },
        { title: "采集时间", dataIndex: "capturedAt", render: formatDateTime },
        { title: "证据", render: (_, row) => <ButtonLink url={row.evidenceUrl} /> }
      ]} />
    </section>
  </>;
}

function ButtonLink({ url }: { url: string }) {
  return url ? <a href={url} target="_blank" rel="noreferrer">查看</a> : <span>无</span>;
}
