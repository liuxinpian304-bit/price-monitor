import { DownloadOutlined, PlusOutlined, UploadOutlined } from "@ant-design/icons";
import { Alert, Button, Input, message, Space, Switch, Table } from "antd";
import { useMemo, useState } from "react";

import { apiRequest, useApiData } from "../api/client.ts";
import type { CatalogModel } from "../api/types.ts";
import { PageToolbar } from "../components/PageToolbar.tsx";
import { ImportDialog, type ImportError } from "../features/catalog/ImportDialog.tsx";
import { CatalogModelDialog } from "../features/catalog/CatalogModelDialog.tsx";
import { fallbackCatalog } from "../data/api-fallbacks.ts";

const demoErrors: ImportError[] = [];

export function CatalogPage() {
  const [importOpen, setImportOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<CatalogModel | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [messageApi, contextHolder] = message.useMessage();
  const { data: models, error, refresh } = useApiData<CatalogModel[]>("/api/catalog/models", fallbackCatalog);
  const filteredModels = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle === "" ? models : models.filter((model) =>
      [model.monitorCode, model.brand, model.standardModel].some((value) => value.toLocaleLowerCase().includes(needle))
    );
  }, [models, query]);

  const toggle = async (model: CatalogModel) => {
    try {
      await apiRequest(`/api/catalog/models/${model.id}/toggle`, { method: "POST", role: "ADMIN", actorId: "本地管理员" });
      await refresh();
      messageApi.success(model.enabled ? "已暂停监控" : "已启用监控");
    } catch (toggleError) {
      messageApi.error(toggleError instanceof Error ? toggleError.message : "启停失败");
    }
  };

  return <>
    {contextHolder}
    <PageToolbar
      title="监控型号"
      description="裸机和套装分别建立监控编号；修改规则会保留审计记录。"
      actions={<Space wrap>
        <Button icon={<DownloadOutlined />} href="/api/catalog/template" download>下载模板</Button>
        <Button type="primary" icon={<UploadOutlined />} onClick={() => setImportOpen(true)}>导入型号</Button>
        <Button icon={<PlusOutlined />} onClick={() => setEditingModel("new")}>新增型号</Button>
      </Space>}
    />
    {error ? <Alert className="data-warning" type="warning" showIcon message="型号数据暂时无法刷新" description={error} /> : null}
    <section className="panel table-panel">
      <div className="table-tools"><Input.Search value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索品牌、型号或监控编号" allowClear /></div>
      <Table
        rowKey="id"
        dataSource={filteredModels}
        scroll={{ x: 900 }}
        columns={[
          { title: "监控编号", dataIndex: "monitorCode", width: 120 },
          { title: "品牌", dataIndex: "brand", width: 130 },
          { title: "标准型号", dataIndex: "standardModel", width: 210, render: (value) => <strong>{value}</strong> },
          { title: "类目", dataIndex: "category", width: 110 },
          { title: "比价类型", dataIndex: "comparisonType", width: 100, render: (value) => value === "BARE" ? "裸机" : "套装" },
          { title: "负责人", dataIndex: "owner", width: 100 },
          { title: "启用", dataIndex: "enabled", width: 90, render: (enabled, row) => <Switch size="small" checked={enabled} onChange={() => void toggle(row)} /> },
          { title: "操作", width: 110, render: (_, row) => <Button type="link" onClick={() => setEditingModel(row)}>编辑规则</Button> }
        ]}
      />
    </section>
    <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} errors={demoErrors} onImported={() => void refresh()} />
    <CatalogModelDialog
      open={editingModel !== null}
      model={editingModel === "new" ? null : editingModel}
      onClose={() => setEditingModel(null)}
      onSaved={async (created) => {
        await refresh();
        messageApi.success(created ? "监控型号已新增" : "监控规则已更新");
      }}
    />
  </>;
}
