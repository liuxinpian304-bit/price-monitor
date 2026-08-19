import { createBrowserRouter } from "react-router-dom";

import { AppShell } from "./AppShell.tsx";
import { AlertDetailPage } from "../pages/AlertDetailPage.tsx";
import { AlertsPage } from "../pages/AlertsPage.tsx";
import { BareComparisonPage } from "../pages/BareComparisonPage.tsx";
import { BundleComparisonPage } from "../pages/BundleComparisonPage.tsx";
import { CatalogPage } from "../pages/CatalogPage.tsx";
import { DashboardPage } from "../pages/DashboardPage.tsx";
import { HistoryPage } from "../pages/HistoryPage.tsx";
import { ManualClassificationPage } from "../pages/ManualClassificationPage.tsx";
import { SettingsPage } from "../pages/SettingsPage.tsx";

export const router = createBrowserRouter([{
  path: "/",
  element: <AppShell />,
  children: [
    { index: true, element: <DashboardPage /> },
    { path: "catalog", element: <CatalogPage /> },
    { path: "compare/bare", element: <BareComparisonPage /> },
    { path: "compare/bundle", element: <BundleComparisonPage /> },
    { path: "classification", element: <ManualClassificationPage /> },
    { path: "alerts", element: <AlertsPage /> },
    { path: "alerts/:alertId", element: <AlertDetailPage /> },
    { path: "history", element: <HistoryPage /> },
    { path: "settings", element: <SettingsPage /> }
  ]
}]);
