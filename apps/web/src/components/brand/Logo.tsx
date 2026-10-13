import { Link } from "react-router";
import { cn } from "@/lib/cn";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden>
      <defs>
        <linearGradient id="bca-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#22D3EE" />
          <stop offset="1" stopColor="#8B5CF6" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#0C1322" stroke="url(#bca-g)" strokeOpacity=".6" />
      <path d="M8 20.5 13 14.5l4 3 7-8" fill="none" stroke="url(#bca-g)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="9.5" r="2.2" fill="#22D3EE" />
    </svg>
  );
}

export function Logo({ to = "/", className, compact }: { to?: string; className?: string; compact?: boolean }) {
  return (
    <Link to={to} className={cn("inline-flex items-center gap-2.5 font-display text-[15px] font-semibold tracking-tight", className)}>
      <LogoMark />
      {!compact && (
        <span>
          Business Command <span className="text-gradient">AI</span>
        </span>
      )}
    </Link>
  );
}
