import type { ReactNode } from "react";
import { AlertTriangle, Lock } from "lucide-react";
import { cn } from "@/lib/cn";

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong px-6 py-12 text-center", className)}>
      {icon && <div className="grid size-12 place-items-center rounded-xl border border-line bg-panel-2 text-accent">{icon}</div>}
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Explains why a control or page is unavailable and how to unblock it. */
export function Prerequisite({ title, children, action, tone = "info" }: { title: string; children: ReactNode; action?: ReactNode; tone?: "info" | "warning" }) {
  return (
    <div role="note" className={cn("flex gap-3 rounded-xl border p-4", tone === "warning" ? "border-warning/30 bg-warning/5" : "border-accent/25 bg-accent/5")}>
      <div className={cn("mt-0.5 shrink-0", tone === "warning" ? "text-warning" : "text-accent")}>
        {tone === "warning" ? <AlertTriangle className="size-5" /> : <Lock className="size-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <div className="mt-1 text-sm text-muted">{children}</div>
        {action && <div className="mt-3 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-danger/30 bg-danger/5 px-6 py-10 text-center">
      <AlertTriangle className="size-6 text-danger" />
      <p className="text-sm text-fg">{error instanceof Error ? error.message : "Something went wrong."}</p>
      {onRetry && (
        <button onClick={onRetry} className="text-sm font-medium text-accent hover:underline">
          Try again
        </button>
      )}
    </div>
  );
}
