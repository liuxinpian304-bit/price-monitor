import "antd/dist/reset.css";
import "./styles.css";

import { ConfigProvider } from "antd";
import zhCN from "antd/es/locale/zh_CN.js";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { router } from "./app/router.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#008f83",
          colorInfo: "#008f83",
          colorSuccess: "#16a34a",
          colorWarning: "#f97316",
          colorError: "#dc2626",
          borderRadius: 6,
          fontSize: 14,
          colorText: "#17212b",
          colorBorder: "#d9e0e5",
          colorBgLayout: "#f5f7f8",
          fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
        },
        components: {
          Table: { headerBg: "#f5f7f8", headerColor: "#475467", rowHoverBg: "#f0fbf9" },
          Menu: { itemBorderRadius: 5, itemSelectedBg: "#e8f7f5", itemSelectedColor: "#007a70" },
          Button: { primaryShadow: "none" }
        }
      }}
    >
      <RouterProvider router={router} />
    </ConfigProvider>
  </React.StrictMode>
);
