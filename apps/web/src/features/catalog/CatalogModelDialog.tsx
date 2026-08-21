import { Alert, Button, Form, Input, Modal, Select, Switch } from "antd";
import { useEffect, useState } from "react";

import { apiRequest } from "../../api/client.ts";
import type { CatalogModel } from "../../api/types.ts";
import { catalogFormValues, toCatalogPayload, type CatalogFormValues } from "./catalog-model-form.ts";

interface CatalogModelDialogProps {
  open: boolean;
  model: CatalogModel | null;
  onClose: () => void;
  onSaved: (created: boolean) => void | Promise<void>;
}

export function CatalogModelDialog({ open, model, onClose, onSaved }: CatalogModelDialogProps) {
  const [form] = Form.useForm<CatalogFormValues>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const comparisonType = Form.useWatch("comparisonType", form);

  useEffect(() => {
    if (open) {
      form.setFieldsValue(catalogFormValues(model));
      setError(null);
    }
  }, [form, model, open]);

  const submit = async (values: CatalogFormValues) => {
    setSaving(true);
    setError(null);
    try {
      await apiRequest(model ? `/api/catalog/models/${model.id}` : "/api/catalog/models", {
        method: model ? "PATCH" : "POST",
        role: "ADMIN",
        actorId: "本地管理员",
        body: JSON.stringify(toCatalogPayload(values))
      });
      await onSaved(!model);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存型号失败");
    } finally {
      setSaving(false);
    }
  };

  return <Modal
    open={open}
    title={model ? `编辑 ${model.monitorCode}` : "新增监控型号"}
    onCancel={onClose}
    footer={null}
    width={760}
    destroyOnHidden
  >
    {error ? <Alert className="form-error" type="error" showIcon message={error} /> : null}
    <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
      <div className="model-form-grid">
        <Form.Item label="监控编号" name="monitorCode" rules={[{ required: true, message: "请填写监控编号" }]}><Input placeholder="MON-0007" /></Form.Item>
        <Form.Item label="是否启用" name="enabled" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item label="品牌" name="brand" rules={[{ required: true, message: "请填写品牌" }]}><Input /></Form.Item>
        <Form.Item label="标准型号" name="standardModel" rules={[{ required: true, message: "请填写标准型号" }]}><Input /></Form.Item>
        <Form.Item label="类目" name="category" rules={[{ required: true }]}><Select options={["声卡", "麦克风", "监听音箱", "耳机", "调音台", "话放", "音频线", "其他"].map((value) => ({ value, label: value }))} /></Form.Item>
        <Form.Item label="型号版本" name="version"><Input placeholder="如：FS新版、国行" /></Form.Item>
        <Form.Item className="form-span-2" label="搜索关键词" name="searchQuery" rules={[{ required: true, message: "请填写搜索关键词" }]}><Input /></Form.Item>
        <Form.Item label="必须包含词" name="mustIncludeTerms"><Input placeholder="用英文分号 ; 分隔" /></Form.Item>
        <Form.Item label="排除词" name="excludedTerms"><Input placeholder="二手;租赁;定金;维修" /></Form.Item>
        <Form.Item className="form-span-2" label="我方商品链接" name="ownUrl" rules={[{ required: true, type: "url", message: "请填写有效商品链接" }]}><Input /></Form.Item>
        <Form.Item className="form-span-2" label="我方具体 SKU" name="ownSkuText" rules={[{ required: true, message: "请填写具体 SKU" }]}><Input /></Form.Item>
        <Form.Item label="比价类型" name="comparisonType" rules={[{ required: true }]}><Select options={[{ value: "BARE", label: "裸机" }, { value: "BUNDLE", label: "套装" }]} /></Form.Item>
        <Form.Item label="套装编号" name="bundleCode" rules={comparisonType === "BUNDLE" ? [{ required: true, message: "套装必须填写已存在的套装编号" }] : []}><Input disabled={comparisonType !== "BUNDLE"} placeholder="PKG-RME-001" /></Form.Item>
        <Form.Item label="颜色可互比" name="colorComparable" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item label="负责人" name="owner" rules={[{ required: true, message: "请填写负责人" }]}><Input /></Form.Item>
        <Form.Item className="form-span-2" label="备注" name="notes"><Input.TextArea rows={2} maxLength={500} showCount /></Form.Item>
      </div>
      <div className="modal-actions">
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" htmlType="submit" loading={saving}>保存型号</Button>
      </div>
    </Form>
  </Modal>;
}
