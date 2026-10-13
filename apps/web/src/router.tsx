import { createBrowserRouter, Navigate } from "react-router";
import { RequireAuth } from "./pages/auth/RequireAuth";
import { Login } from "./pages/auth/Login";
import { Signup } from "./pages/auth/Signup";
import { AcceptInvite } from "./pages/auth/AcceptInvite";
import { MarketingLayout } from "./pages/marketing/MarketingLayout";
import { Home } from "./pages/marketing/Home";
import { AppIndex } from "./pages/app/AppIndex";
import { Onboarding } from "./pages/app/Onboarding";
import { BusinessLayout, WorkspaceLayout } from "./components/shell/Layouts";
import { CommandCenter } from "./pages/app/CommandCenter";
import { Businesses } from "./pages/app/Businesses";
import { BusinessSettings } from "./pages/app/BusinessSettings";
import { Team } from "./pages/app/Team";
import { WorkspaceSettings } from "./pages/app/WorkspaceSettings";
import { Account } from "./pages/app/Account";
import { StagePlaceholder } from "./pages/app/StagePlaceholder";
import { NotFound } from "./pages/NotFound";

export const router = createBrowserRouter([
  {
    element: <MarketingLayout />,
    children: [{ index: true, element: <Home /> }],
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
          { path: "assistant", element: <StagePlaceholder area="AI Assistant" stage={5} /> },
          { path: "dashboards/*", element: <StagePlaceholder area="Dashboards" stage={2} /> },
          { path: "connections", element: <StagePlaceholder area="Connections" stage={3} /> },
          { path: "insights", element: <StagePlaceholder area="Insights" stage={7} /> },
          { path: "automations", element: <StagePlaceholder area="Automations" stage={7} /> },
          { path: "reports", element: <StagePlaceholder area="Reports" stage={7} /> },
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
          { path: "billing", element: <StagePlaceholder area="Billing" stage={9} /> },
          { path: "account", element: <Account /> },
          { path: "admin", element: <StagePlaceholder area="Platform administration" stage={9} /> },
        ],
      },
    ],
  },
  { path: "*", element: <NotFound /> },
]);
