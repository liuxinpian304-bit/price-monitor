import { CheckCircleOutlined, ClockCircleOutlined, LoadingOutlined } from "@ant-design/icons";
import { Alert, Button, Table } from "antd";
import { Link } from "react-router-dom";

import { useApiData } from "../api/client.ts";
import type { ApiAlert, DashboardData } from "../api/types.ts";
import { StatusText } from "../components/StatusText.tsx";
import { fallbackDashboard } from "../data/api-fallbacks.ts";
import { formatFen } from "../data/demo-data.ts";

function money(value: number | null) {
  return value === null ? "--" : formatFen(value);
}

function dateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export function DashboardPage() {
  const { data, error } = useApiData<DashboardData>("/api/operations/dashboard", fallbackDashboard);
  const stats = [
    { label: "今日扫描", value: String(data.stats.scansToday), suffix: `/${data.stats.plannedScans}`, tone: "teal" },
    { label: "监控型号", value: String(data.stats.monitoredModels), suffix: "", tone: "teal" },
    { label: "低价事件", value: String(data.stats.lowEvents), suffix: "", tone: "orange" },
    { label: "待处理", value: String(data.stats.pendingAlerts), suffix: "", tone: "orange" },
    { label: "采集异常", value: String(data.stats.failedRuns), suffix: "", tone: "red" }
  ];
  return <div className="dashboard-page">
    {error ? <Alert className="data-warning" type="warning" showIcon message="后台连接异常，当前显示上次可用数据" description={error} /> : null}
    <div className="summary-strip">
      {stats.map((stat) => <div className="summary-item" key={stat.label}>
        <span>{stat.label}</span>
        <strong className={`tone-${stat.tone}`}>{stat.value}<small>{stat.suffix}</small></strong>
      </div>)}
    </div>

    <div className="dashboard-grid">
      <section className="panel latest-alerts">
        <div className="panel-heading">
          <h2>最新低价事件</h2>
          <Link to="/alerts"><Button type="link">查看全部</Button></Link>
        </div>
        <Table
          rowKey="id"
          size="middle"
          pagination={false}
          scroll={{ x: 860 }}
          dataSource={data.latestAlerts.slice(0, 4)}
          columns={[
            { title: "型号", dataIndex: "model", width: 210, render: (model: string, row: ApiAlert) => <Link to={`/alerts/${row.id}`} className="model-link">{model}</Link> },
            { title: "类型", dataIndex: "type", width: 72, render: (type: string) => type === "BARE" ? "裸机" : "套装" },
            { title: "我方到手价", dataIndex: "ownPriceFen", width: 118, align: "right", render: money },
            { title: "同行最低价", dataIndex: "competitorPriceFen", width: 118, align: "right", render: (price: number | null) => <span className="risk-price">{money(price)}</span> },
            { title: "价差", dataIndex: "differenceFen", width: 100, align: "right", render: (difference: number | null) => <span className="risk-price">{difference === null ? "--" : `-${formatFen(difference)}`}</span> },
            { title: "同行店铺", dataIndex: "competitorShop", width: 160 },
            { title: "发现时间", dataIndex: "foundAt", width: 170, render: dateTime },
            { title: "状态", dataIndex: "status", width: 90, render: (status) => <StatusText status={status} /> }
          ]}
        />
      </section>

      <aside className="panel schedule-panel">
        <div className="panel-heading"><h2>今日检查计划</h2><span>Asia/Shanghai</span></div>
        <div className="schedule-list">
          {data.schedule.map((item) => <div className="schedule-row" key={item.time}>
            <ClockCircleOutlined />
            <strong>{item.time}</strong>
            <span className={`schedule-status schedule-${item.status.toLocaleLowerCase()}`}>
              {item.status === "DONE" ? <><CheckCircleOutlined /> 已完成</> : item.status === "RUNNING" ? <><LoadingOutlined /> 检查中</> : "待执行"}
            </span>
          </div>)}
        </div>
      </aside>
    </div>
  </div>;
}
