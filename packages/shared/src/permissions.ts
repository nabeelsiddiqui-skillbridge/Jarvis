/**
 * Role & permission model, shared by the API (enforcement) and the web app
 * (deciding which controls to enable). The server is always the authority —
 * the client copy only drives UI affordances.
 *
 * Workspace roles:  owner | member
 * Business roles:   admin | analyst | viewer
 * A workspace owner implicitly holds the "owner" role on every business in it.
 */

export const WORKSPACE_ROLES = ["owner", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const BUSINESS_ROLES = ["admin", "analyst", "viewer"] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

/** Effective role on a business (owner is derived from the workspace role). */
export type EffectiveBusinessRole = "owner" | BusinessRole;

export const PERMISSIONS = [
  "business.read",
  "business.update",
  "business.delete",
  "business.members.manage",
  "goals.write",
  "dashboard.read",
  "dashboard.write",
  "dashboard.share",
  "assistant.use",
  "insight.read",
  "insight.manage",
  "report.read",
  "report.write",
  "data.export",
  "connection.read",
  "connection.manage",
  "automation.read",
  "automation.write",
  "action.propose",
  "action.approve",
  "audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  "business.read",
  "dashboard.read",
  "assistant.use",
  "insight.read",
  "report.read",
  "connection.read",
  "automation.read",
];

const ANALYST: Permission[] = [
  ...VIEWER,
  "dashboard.write",
  "dashboard.share",
  "insight.manage",
  "report.write",
  "data.export",
  "goals.write",
  "automation.write",
  "action.propose",
];

const ADMIN: Permission[] = [
  ...ANALYST,
  "business.update",
  "business.members.manage",
  "connection.manage",
  "action.approve",
  "audit.read",
];

const OWNER: Permission[] = [...ADMIN, "business.delete"];

export const ROLE_PERMISSIONS: Record<EffectiveBusinessRole, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  analyst: new Set(ANALYST),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export function can(role: EffectiveBusinessRole | null | undefined, permission: Permission): boolean {
  return role ? ROLE_PERMISSIONS[role].has(permission) : false;
}

/** Workspace-level abilities (only owners manage the workspace itself). */
export const WORKSPACE_PERMISSIONS = {
  "workspace.manage": ["owner"],
  "workspace.members.manage": ["owner"],
  "billing.manage": ["owner"],
  "business.create": ["owner"],
} as const satisfies Record<string, readonly WorkspaceRole[]>;
export type WorkspacePermission = keyof typeof WORKSPACE_PERMISSIONS;

export function canWorkspace(role: WorkspaceRole | null | undefined, permission: WorkspacePermission): boolean {
  return role ? (WORKSPACE_PERMISSIONS[permission] as readonly string[]).includes(role) : false;
}

export const ROLE_LABELS: Record<EffectiveBusinessRole, string> = {
  owner: "Workspace owner",
  admin: "Business administrator",
  analyst: "Analyst",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<EffectiveBusinessRole, string> = {
  owner: "Full control of the workspace, billing and every business in it.",
  admin: "Manages the business: connections, members, approvals and settings.",
  analyst: "Builds dashboards, reports and automations; can propose actions.",
  viewer: "Reads dashboards, insights and reports and can ask the assistant.",
};
