import { Alert, Button, message, Space, Table } from "antd";
import { useState } from "react";

import { apiRequest, useApiData } from "../api/client.ts";
import type { ManualCandidate } from "../api/types.ts";
import { PageToolbar } from "../components/PageToolbar.tsx";
import { fallbackManualCandidates } from "../data/api-fallbacks.ts";

export function ManualClassificationPage() {
  const { data: rows, error, refresh } = useApiData<ManualCandidate[]>("/api/operations/manual-candidates", fallbackManualCandidates);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const classify = async (candidate: ManualCandidate, decision: "BARE" | "BUNDLE" | "REJECTED") => {
    setSubmitting(`${candidate.id}-${decision}`);
    try {
      await apiRequest(`/api/operations/manual-candidates/${candidate.id}`, {
        method: "PATCH",
        actorId: "本地运营",
        body: JSON.stringify({ decision })
      });
      await refresh();
      messageApi.success("分类结果已保存");
    } catch (classificationError) {
      messageApi.error(classificationError instanceof Error ? classificationError.message : "保存分类失败");
    } finally {
      setSubmitting(null);
    }
  };

  return <>
    {contextHolder}
    <PageToolbar title="待人工分类" description="系统不确定时不强制比较，由运营确认商品类型和规格。" />
    {error ? <Alert className="data-warning" type="warning" showIcon message="人工分类数据暂时无法刷新" description={error} /> : null}
    <section className="panel table-panel">
      <Table rowKey="id" dataSource={rows} columns={[
        { title: "商品标题", dataIndex: "title", width: 300, render: (value) => <strong>{value}</strong> },
        { title: "具体SKU", dataIndex: "sku", width: 180 },
        { title: "同行店铺", dataIndex: "shop", width: 170 },
        { title: "进入人工原因", dataIndex: "reason" },
        { title: "发现时间", dataIndex: "foundAt", width: 170, render: (value) => new Date(value).toLocaleString("zh-CN", { hour12: false }) },
        { title: "分类", width: 190, render: (_, row) => <Space>
          <Button size="small" loading={submitting === `${row.id}-BARE`} onClick={() => void classify(row, "BARE")}>裸机</Button>
          <Button size="small" loading={submitting === `${row.id}-BUNDLE`} onClick={() => void classify(row, "BUNDLE")}>套装</Button>
          <Button size="small" danger loading={submitting === `${row.id}-REJECTED`} onClick={() => void classify(row, "REJECTED")}>排除</Button>
        </Space> }
      ]} />
    </section>
  </>;
}
