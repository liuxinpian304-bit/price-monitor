import { Button, Form, Input, Select, Space } from "antd";

export interface AlertActionValues {
  status: "PRICE_CHANGED" | "NO_FOLLOW" | "FALSE_POSITIVE" | "WATCHING";
  reasonCode?: string;
  note?: string;
}

const reasons = [
  { value: "UNAUTHORIZED_SHOP", label: "非授权店" },
  { value: "NON_OFFICIAL", label: "非国行" },
  { value: "DIFFERENT_GIFTS", label: "赠品不同" },
  { value: "DIFFERENT_SERVICE", label: "服务不同" },
  { value: "ABNORMAL_STOCK", label: "库存异常" },
  { value: "TEMPORARY_PROMOTION", label: "活动临时价" },
  { value: "BELOW_MARGIN", label: "低于利润底线" },
  { value: "PRICE_CONTROL", label: "品牌控价限制" },
  { value: "WRONG_MODEL", label: "型号或配置识别错误" },
  { value: "WRONG_PRICE", label: "价格识别错误" }
];

export function AlertActionForm({ onSubmit }: { onSubmit: (values: AlertActionValues) => void | Promise<void> }) {
  const [form] = Form.useForm<AlertActionValues>();
  const status = Form.useWatch("status", form);
  const reasonRequired = status === "NO_FOLLOW" || status === "FALSE_POSITIVE";

  const handleSubmit = async (values: AlertActionValues) => {
    const requiresReason = values.status === "NO_FOLLOW" || values.status === "FALSE_POSITIVE";
    if (requiresReason && !values.reasonCode) {
      form.setFields([{
        name: "reasonCode",
        errors: [values.status === "NO_FOLLOW" ? "请选择不跟价原因" : "请选择误报原因"]
      }]);
      return;
    }

    await onSubmit(values);
  };

  return <Form form={form} layout="vertical" onFinish={handleSubmit} className="action-form">
    <Form.Item name="status" label="处理结果" rules={[{ required: true, message: "请选择处理结果" }]}>
      <Select aria-label="处理结果" placeholder="请选择">
        <Select.Option value="PRICE_CHANGED">已改价</Select.Option>
        <Select.Option value="NO_FOLLOW">不跟价</Select.Option>
        <Select.Option value="FALSE_POSITIVE">误报</Select.Option>
        <Select.Option value="WATCHING">继续观察</Select.Option>
      </Select>
    </Form.Item>

    {reasonRequired ? <Form.Item
      name="reasonCode"
      label={status === "NO_FOLLOW" ? "不跟价原因" : "误报原因"}
      rules={[{ required: true, message: status === "NO_FOLLOW" ? "请选择不跟价原因" : "请选择误报原因" }]}
    >
      <Select aria-label="处理原因" options={reasons} placeholder="请选择原因" />
    </Form.Item> : null}

    <Form.Item name="note" label="备注">
      <Input.TextArea rows={3} maxLength={500} showCount placeholder="补充处理说明" />
    </Form.Item>
    <Space>
      <Button type="primary" htmlType="submit">确认处理</Button>
      <Button onClick={() => form.resetFields()}>清空</Button>
    </Space>
  </Form>;
}
