import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "accent" | "violet" | "success" | "warning" | "danger" | "demo";
const tones: Record<Tone, string> = {
  neutral: "border-line text-muted bg-white/[0.03]",
  accent: "border-accent/30 text-accent bg-accent/10",
  violet: "border-violet/35 text-[#c4b5fd] bg-violet/10",
  success: "border-success/30 text-success bg-success/10",
  warning: "border-warning/30 text-warning bg-warning/10",
  danger: "border-danger/35 text-danger bg-danger/10",
  demo: "border-demo/40 text-demo bg-demo/10",
};

export function Badge({ tone = "neutral", children, className, icon, title }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-medium", tones[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export function DemoBadge({ className }: { className?: string }) {
  return (
    <Badge tone="demo" className={className}>
      Demo data
    </Badge>
  );
}
