import { Alert, Button, Form, Input, message, Select, Space, Switch, Tag } from "antd";
import { useEffect, useState } from "react";

import { apiRequest, useApiData } from "../api/client.ts";
import type { PublicSettings } from "../api/types.ts";
import { PageToolbar } from "../components/PageToolbar.tsx";
import { fallbackSettings } from "../data/api-fallbacks.ts";

export function SettingsPage() {
  const { data, error, refresh } = useApiData<PublicSettings>("/api/settings", fallbackSettings);
  const [form] = Form.useForm<{ shop: string; provider: "manual" | "external"; enabled: boolean }>();
  const [times, setTimes] = useState<string[]>(data.checkTimes);
  const [wecomWebhook, setWecomWebhook] = useState("");
  const [commerceApiKey, setCommerceApiKey] = useState("");
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    form.setFieldsValue({ shop: data.shopName, provider: data.provider, enabled: data.schedulerEnabled });
    setTimes(data.checkTimes);
  }, [data, form]);

  const saveBase = async () => {
    const values = await form.validateFields();
    try {
      await Promise.all([
        apiRequest("/api/settings/provider", { method: "PATCH", role: "ADMIN", actorId: "本地管理员", body: JSON.stringify({ provider: values.provider }) }),
        apiRequest("/api/settings/schedule", { method: "PATCH", role: "ADMIN", actorId: "本地管理员", body: JSON.stringify({ enabled: values.enabled, checkTimes: times }) })
      ]);
      await refresh();
      messageApi.success("基础配置已保存");
    } catch (saveError) {
      messageApi.error(saveError instanceof Error ? saveError.message : "保存失败");
    }
  };

  const saveSecret = async (kind: "wecom" | "commerce-api") => {
    const value = kind === "wecom" ? wecomWebhook : commerceApiKey;
    if (!value.trim()) {
      messageApi.warning("请先填写要保存的密钥");
      return;
    }
    try {
      await apiRequest(`/api/settings/secrets/${kind}`, {
        method: "PUT",
        role: "ADMIN",
        actorId: "本地管理员",
        body: JSON.stringify({ value })
      });
      kind === "wecom" ? setWecomWebhook("") : setCommerceApiKey("");
      await refresh();
      messageApi.success("密钥已加密保存");
    } catch (saveError) {
      messageApi.error(saveError instanceof Error ? saveError.message : "保存失败");
    }
  };

  return <>
    {contextHolder}
    <PageToolbar title="系统设置" description="密钥仅加密保存，页面和日志不回显明文。" />
    {error ? <Alert className="data-warning" type="warning" showIcon message="系统配置暂时无法刷新" description={error} /> : null}
    <div className="settings-layout">
      <section className="panel settings-section">
        <h3>基础配置</h3>
        <Form form={form} layout="vertical">
          <Form.Item label="我方店铺" name="shop"><Input disabled /></Form.Item>
          <Form.Item label="商品数据源" name="provider"><Select options={[{ value: "manual", label: "手工固定样例（开发）" }, { value: "external", label: "外部合规数据 API" }]} /></Form.Item>
          <Form.Item label="启用自动检查（配置预留）" name="enabled" valuePropName="checked"><Switch /></Form.Item>
          <Button type="primary" onClick={() => void saveBase()}>保存基础配置</Button>
        </Form>
      </section>

      <section className="panel settings-section">
        <h3>秘密配置</h3>
        <Form layout="vertical">
          <Form.Item label={<Space>企业微信机器人 Webhook <Tag color={data.wecomWebhookConfigured ? "green" : "default"}>{data.wecomWebhookConfigured ? "已配置" : "未配置"}</Tag></Space>}>
            <Input.Password value={wecomWebhook} onChange={(event) => setWecomWebhook(event.target.value)} placeholder="输入新 Webhook，保存后不再回显" />
          </Form.Item>
          <Button onClick={() => void saveSecret("wecom")}>更新 Webhook</Button>
          <Form.Item className="secret-field" label={<Space>外部数据 API 密钥 <Tag color={data.commerceApiKeyConfigured ? "green" : "default"}>{data.commerceApiKeyConfigured ? "已配置" : "未配置"}</Tag></Space>}>
            <Input.Password value={commerceApiKey} onChange={(event) => setCommerceApiKey(event.target.value)} placeholder="输入新 API 密钥，保存后不再回显" />
          </Form.Item>
          <Button onClick={() => void saveSecret("commerce-api")}>更新 API 密钥</Button>
        </Form>
      </section>

      <section className="panel settings-section schedule-settings">
        <h3>每日检查时间 <small>{data.timeZone}</small></h3>
        <div className="time-grid">{times.map((time, index) => <Input
          key={`${index}-${time}`}
          type="time"
          value={time}
          aria-label={`检查时间 ${time}`}
          onChange={(event) => setTimes((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
        />)}</div>
        <Button type="primary" onClick={() => void saveBase()}>保存检查计划配置</Button>
      </section>
    </div>
  </>;
}
