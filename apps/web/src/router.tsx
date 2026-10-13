import { createBrowserRouter, Navigate } from "react-router";
import { RequireAuth } from "./pages/auth/RequireAuth";
import { Login } from "./pages/auth/Login";
import { Signup } from "./pages/auth/Signup";
import { AcceptInvite } from "./pages/auth/AcceptInvite";
import { MarketingLayout } from "./pages/marketing/MarketingLayout";
import { Home } from "./pages/marketing/Home";
import { Pricing } from "./pages/marketing/Pricing";
import { Security } from "./pages/marketing/Security";
import { AppIndex } from "./pages/app/AppIndex";
import { Onboarding } from "./pages/app/Onboarding";
import { BusinessLayout, WorkspaceLayout } from "./components/shell/Layouts";
import { CommandCenter } from "./pages/app/CommandCenter";
import { Dashboards } from "./pages/app/Dashboards";
import { DashboardView } from "./pages/app/DashboardView";
import { Connections } from "./pages/app/Connections";
import { Businesses } from "./pages/app/Businesses";
import { BusinessSettings } from "./pages/app/BusinessSettings";
import { Team } from "./pages/app/Team";
import { WorkspaceSettings } from "./pages/app/WorkspaceSettings";
import { Account } from "./pages/app/Account";
import { Billing } from "./pages/app/Billing";
import { Admin } from "./pages/app/Admin";
import { Assistant } from "./pages/app/Assistant";
import { Insights } from "./pages/app/Insights";
import { Automations } from "./pages/app/Automations";
import { ReportView, Reports } from "./pages/app/Reports";
import { NotFound } from "./pages/NotFound";

export const router = createBrowserRouter([
  {
    element: <MarketingLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: "pricing", element: <Pricing /> },
      { path: "security", element: <Security /> },
    ],
  },
  { path: "/login", element: <Login /> },
  { path: "/signup", element: <Signup /> },
  { path: "/invite/:token", element: <AcceptInvite /> },
  {
    path: "/app",
    element: <RequireAuth />,
    children: [
      { index: true, element: <AppIndex /> },
      { path: "onboarding", element: <Onboarding /> },
      {
        path: "b/:businessId",
        element: <BusinessLayout />,
        children: [
          { index: true, element: <CommandCenter /> },
          { path: "assistant", element: <Assistant /> },
          { path: "dashboards", element: <Dashboards /> },
          { path: "dashboards/:dashboardId", element: <DashboardView /> },
          { path: "connections", element: <Connections /> },
          { path: "insights", element: <Insights /> },
          { path: "automations", element: <Automations /> },
          { path: "reports", element: <Reports /> },
          { path: "reports/:reportId", element: <ReportView /> },
          { path: "settings", element: <BusinessSettings /> },
        ],
      },
      {
        path: "w/:workspaceId",
        element: <WorkspaceLayout />,
        children: [
          { index: true, element: <Navigate to="businesses" replace /> },
          { path: "businesses", element: <Businesses /> },
          { path: "team", element: <Team /> },
          { path: "settings", element: <WorkspaceSettings /> },
          { path: "billing", element: <Billing /> },
          { path: "account", element: <Account /> },
          { path: "admin", element: <Admin /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFound /> },
]);
