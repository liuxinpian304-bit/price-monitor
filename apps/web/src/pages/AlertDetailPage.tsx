import { ArrowLeftOutlined, ExportOutlined } from "@ant-design/icons";
import { Alert, Button, Descriptions, Divider, message, Space } from "antd";
import { Link, useParams } from "react-router-dom";

import { apiRequest, useApiData } from "../api/client.ts";
import type { ApiAlert } from "../api/types.ts";
import { StatusText } from "../components/StatusText.tsx";
import { fallbackAlerts } from "../data/api-fallbacks.ts";
import { formatFen } from "../data/demo-data.ts";
import { AlertActionForm, type AlertActionValues } from "../features/alerts/AlertActionForm.tsx";

function money(value: number | null) {
  return value === null ? "--" : formatFen(value);
}

export function AlertDetailPage() {
  const { alertId = "" } = useParams();
  const fallback = fallbackAlerts.find((item) => item.id === alertId) ?? fallbackAlerts[0]!;
  const { data: alert, error, refresh } = useApiData<ApiAlert>(`/api/alerts/${alertId}`, fallback);
  const [messageApi, contextHolder] = message.useMessage();

  const submit = async (values: AlertActionValues) => {
    try {
      await apiRequest(`/api/alerts/${alert.id}/actions`, {
        method: "POST",
        actorId: "本地运营",
        body: JSON.stringify(values)
      });
      await refresh();
      messageApi.success("处理结果已保存");
    } catch (submitError) {
      messageApi.error(submitError instanceof Error ? submitError.message : "处理失败");
    }
  };

  return <>
    {contextHolder}
    {error ? <Alert className="data-warning" type="warning" showIcon message="预警详情暂时无法刷新" description={error} /> : null}
    <div className="detail-header">
      <Space wrap><Link to="/alerts"><Button icon={<ArrowLeftOutlined />}>返回预警</Button></Link><h2>{alert.model}</h2><StatusText status={alert.status} /></Space>
      <Button icon={<ExportOutlined />}>导出证据</Button>
    </div>
    <div className="detail-grid">
      <section className="panel detail-panel">
        <h3>价格与商品证据</h3>
        <div className="price-comparison">
          <div><span>我方到手价</span><strong>{money(alert.ownPriceFen)}</strong><small>{alert.ownShop}</small></div>
          <div className="price-gap"><span>低</span><strong>{money(alert.differenceFen)}</strong></div>
          <div><span>同行到手价</span><strong className="risk-price">{money(alert.competitorPriceFen)}</strong><small>{alert.competitorShop}</small></div>
        </div>
        <Divider />
        <Descriptions column={{ xs: 1, sm: 2 }} size="small">
          <Descriptions.Item label="类型">{alert.type === "BARE" ? "裸机" : "套装"}</Descriptions.Item>
          <Descriptions.Item label="负责人">{alert.owner}</Descriptions.Item>
          <Descriptions.Item label="具体SKU">{alert.sku}</Descriptions.Item>
          <Descriptions.Item label="发现时间">{new Date(alert.foundAt).toLocaleString("zh-CN", { hour12: false })}</Descriptions.Item>
          <Descriptions.Item label="判断依据" span="filled">{alert.reasons.join("；") || "同品牌、同型号、同版本，具体 SKU 到手价已确认"}</Descriptions.Item>
          <Descriptions.Item label="同行链接" span="filled">{alert.competitorUrl ? <a href={alert.competitorUrl} target="_blank" rel="noreferrer">打开天猫商品</a> : "无"}</Descriptions.Item>
        </Descriptions>
      </section>
      <aside className="panel action-panel">
        <h3>运营处理</h3>
        <AlertActionForm onSubmit={submit} />
      </aside>
    </div>
  </>;
}
