import { Alert, Table, Tag } from "antd";
import { Link } from "react-router-dom";

import { useApiData } from "../api/client.ts";
import type { CollectionRunReportList, CollectionRunReportSummary } from "../api/types.ts";
import { PageToolbar } from "../components/PageToolbar.tsx";
import { formatDateTime } from "../features/operations/table-tools.ts";

function completionColor(run: CollectionRunReportSummary): string {
  return run.completion.complete ? "success" : "warning";
}

export function CollectionRunsPage() {
  const { data, error } = useApiData<CollectionRunReportList>(
    "/api/operations/collection-runs",
    { runs: [] },
    { role: "ADMIN" }
  );

  return <>
    <PageToolbar
      title="采集报告"
      description="按运行查看前 50 个搜索位置、全部已采 SKU、未完成项与通知状态。"
    />
    {error ? <Alert className="data-warning" type="warning" showIcon title="采集报告暂时无法刷新" description={error} /> : null}
    <section className="panel table-panel">
      <div className="collection-runs-scroll" data-testid="collection-runs-scroll">
        <Table
          rowKey="id"
          dataSource={data.runs}
          pagination={{ pageSize: 30, showSizeChanger: false }}
          scroll={{ x: 1250 }}
          columns={[
            {
              title: "型号 / 运行", width: 250,
              render: (_value, run: CollectionRunReportSummary) => <div className="run-model-cell">
                <Link className="model-link" to={`/runs/${run.id}`}>{run.model.label}</Link>
                <small>{run.model.monitorCode} · {run.id}</small>
              </div>
            },
            { title: "状态", dataIndex: "status", width: 130, render: (value: string) => <Tag>{value}</Tag> },
            {
              title: "完成度", width: 170,
              render: (_value, run: CollectionRunReportSummary) => <div>
                <Tag color={completionColor(run)}>{run.completion.label}</Tag>
                {run.completion.incompleteCount > 0 ? <small className="run-warning">{run.completion.incompleteCount} 个未完成</small> : null}
              </div>
            },
            { title: "唯一商品", width: 96, render: (_value, run: CollectionRunReportSummary) => run.completion.uniqueItemCount },
            { title: "SKU", width: 80, render: (_value, run: CollectionRunReportSummary) => run.completion.skuCount },
            { title: "采集器", width: 180, render: (_value, run: CollectionRunReportSummary) => run.collector ? `${run.collector.name} (${run.collector.platform})` : "未分配" },
            { title: "计划时间", dataIndex: "scheduledFor", width: 168, render: formatDateTime },
            { title: "结束时间", dataIndex: "finishedAt", width: 168, render: (value: string | null) => value ? formatDateTime(value) : "--" },
            { title: "通知", width: 150, render: (_value, run: CollectionRunReportSummary) => <div><Tag>{run.notification.state}</Tag><small>{run.notification.attempts} 次</small></div> },
            { title: "查看", width: 84, render: (_value, run: CollectionRunReportSummary) => <Link to={`/runs/${run.id}`}>报告</Link> }
          ]}
        />
      </div>
    </section>
  </>;
}
