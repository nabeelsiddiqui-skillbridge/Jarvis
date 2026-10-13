import { Bot, Building2, CreditCard, Gauge, LayoutDashboard, Lightbulb, Plug, FileText, Settings, ShieldCheck, Users, Workflow } from "lucide-react";

export const businessNav = [
  { to: "", label: "Command Center", icon: Gauge, end: true },
  { to: "assistant", label: "AI Assistant", icon: Bot },
  { to: "dashboards", label: "Dashboards", icon: LayoutDashboard },
  { to: "connections", label: "Connections", icon: Plug },
  { to: "insights", label: "Insights", icon: Lightbulb },
  { to: "automations", label: "Automations", icon: Workflow },
  { to: "reports", label: "Reports", icon: FileText },
  { to: "settings", label: "Business settings", icon: Settings },
] as const;

export const workspaceNav = [
  { to: "businesses", label: "Businesses", icon: Building2 },
  { to: "team", label: "Team", icon: Users },
  { to: "billing", label: "Billing", icon: CreditCard },
  { to: "settings", label: "Workspace settings", icon: Settings },
] as const;

export const adminNav = { to: "admin", label: "Platform admin", icon: ShieldCheck } as const;
