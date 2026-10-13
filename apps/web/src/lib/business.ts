import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Business } from "@bca/shared";
import { get, patch } from "./api";

/** Query keys. Every business-owned query is prefixed with ["b", businessId] so a switch can never reuse another business's cache. */
export const keys = {
  businesses: (workspaceId: string) => ["ws", workspaceId, "businesses"] as const,
  business: (businessId: string) => ["b", businessId] as const,
  goals: (businessId: string) => ["b", businessId, "goals"] as const,
  access: (businessId: string) => ["b", businessId, "access"] as const,
  audit: (businessId: string) => ["b", businessId, "audit"] as const,
  members: (workspaceId: string) => ["ws", workspaceId, "members"] as const,
};

export function useBusinesses(workspaceId: string | undefined) {
  return useQuery({
    queryKey: keys.businesses(workspaceId ?? "none"),
    queryFn: ({ signal }) => get<Business[]>(`/workspaces/${workspaceId}/businesses`, signal),
    enabled: Boolean(workspaceId),
    staleTime: 30_000,
  });
}

export function useBusinessQuery(businessId: string | undefined) {
  return useQuery({
    queryKey: keys.business(businessId ?? "none"),
    queryFn: ({ signal }) => get<Business>(`/businesses/${businessId}`, signal),
    enabled: Boolean(businessId),
    retry: (n, e: any) => e?.status !== 404 && n < 2,
  });
}

export const BusinessContext = createContext<Business | null>(null);

/** The active business. Only usable inside the business layout. */
export function useBusiness(): Business {
  const b = useContext(BusinessContext);
  if (!b) throw new Error("useBusiness() used outside a business route");
  return b;
}

export const useOptionalBusiness = () => useContext(BusinessContext);

export const rememberBusiness = (businessId: string, workspaceId: string) =>
  patch("/auth/me/preferences", { recentBusinessId: businessId, lastWorkspaceId: workspaceId }).catch(() => undefined);
