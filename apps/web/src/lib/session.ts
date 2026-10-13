import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

export interface Me {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  workspaces: { id: string; name: string; role: "owner" | "member"; retentionDays: number; businessCount: number }[];
  preferences: {
    lastWorkspaceId: string | null;
    recentBusinessIds: string[];
    onboarding: Record<string, boolean | string>;
    assistantPanelOpen: boolean;
  };
}

export const meKey = ["me"] as const;

export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: ({ signal }) => get<Me>("/auth/me", signal),
    retry: false,
    staleTime: 60_000,
  });
}
