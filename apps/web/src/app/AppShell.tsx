import {
  AlertOutlined,
  ApartmentOutlined,
  BarChartOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  SettingOutlined,
  TagsOutlined,
  UnorderedListOutlined,
  WarningOutlined
} from "@ant-design/icons";
import { Alert, Button, Drawer, Grid, Layout, Menu, Space } from "antd";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { useApiData } from "../api/client.ts";
import type { HealthData } from "../api/types.ts";

const { Header, Sider, Content } = Layout;

const menuItems = [
  { key: "/", icon: <BarChartOutlined />, label: "总览" },
  { key: "/catalog", icon: <TagsOutlined />, label: "型号管理" },
  { key: "/compare/bare", icon: <DatabaseOutlined />, label: "裸机比价" },
  { key: "/compare/bundle", icon: <ApartmentOutlined />, label: "套装比价" },
  { key: "/classification", icon: <UnorderedListOutlined />, label: "待人工分类" },
  { key: "/alerts", icon: <AlertOutlined />, label: "预警中心" },
  { key: "/history", icon: <ClockCircleOutlined />, label: "历史价格" },
  { key: "/settings", icon: <SettingOutlined />, label: "系统设置" }
];

const pageTitles: Record<string, string> = {
  "/": "比价监控总览",
  "/catalog": "型号管理",
  "/compare/bare": "裸机比价",
  "/compare/bundle": "套装比价",
  "/classification": "待人工分类",
  "/alerts": "预警中心",
  "/history": "历史价格",
  "/settings": "系统设置"
};

function Navigation({ onSelect }: { onSelect?: () => void }) {
  const location = useLocation();
  const selected = location.pathname.startsWith("/alerts/") ? "/alerts" : location.pathname;
  return <Menu
    mode="inline"
    selectedKeys={[selected]}
    items={menuItems.map((item) => ({
      ...item,
      label: <NavLink to={item.key} onClick={onSelect}>{item.label}</NavLink>
    }))}
  />;
}

export function AppShell() {
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  const mobile = !screens.lg;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const titleKey = location.pathname.startsWith("/alerts/") ? "/alerts" : location.pathname;
  const health = useApiData<HealthData>("/api/health", { status: "degraded", database: "down", redis: "down" });
  const healthLabel = health.loading ? "连接中" : health.data.status === "ok" ? "服务正常" : "服务异常";

  return <Layout className="app-layout">
    {!mobile ? <Sider width={232} theme="light" className="app-sider">
      <div className="brand-block">
        <div className="brand-mark">ST</div>
        <div>
          <strong>星空乐器专营店</strong>
          <span>天猫比价监控</span>
        </div>
      </div>
      <Navigation />
      <div className="sider-footer"><MenuFoldOutlined /> 运营工作台</div>
    </Sider> : null}

    <Drawer
      open={drawerOpen}
      placement="left"
      size={260}
      onClose={() => setDrawerOpen(false)}
      styles={{ body: { padding: 0 } }}
      title="星空乐器专营店"
    >
      <Navigation onSelect={() => setDrawerOpen(false)} />
    </Drawer>

    <Layout>
      <Header className="app-header">
        <Space size={12}>
          {mobile ? <Button type="text" icon={<MenuOutlined />} onClick={() => setDrawerOpen(true)} aria-label="打开导航" /> : null}
          <h1>{pageTitles[titleKey] ?? "预警详情"}</h1>
        </Space>
        <div className={`system-health health-${health.loading ? "loading" : health.data.status}`} title={health.error ?? undefined}>
          <span className="health-dot" />{healthLabel}
        </div>
      </Header>
      <Content className="app-content">
        <Alert
          className="data-warning"
          type="warning"
          showIcon
          message="开发原型"
          description="当前公开版不会自动执行定时采集，也不会自动发送企业微信消息；页面中的计划、事件和价格可能来自演示数据。"
        />
        <Outlet />
      </Content>
    </Layout>
  </Layout>;
}
