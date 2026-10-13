import { useId, type CSSProperties } from "react";
import { cn } from "@/lib/cn";

/**
 * JARVIS core: layered HUD rings around a glowing core. The rings' speed, colour and
 * pulse follow what the assistant is doing — calm on standby, ripples while listening,
 * fast amber-lit rotation while it retrieves and analyzes data, a quick pulse while it
 * speaks. Boots up (rings assemble) when it first appears. All motion stops for
 * reduced-motion users; the state is always also given in text.
 */
export type CoreState = "standby" | "starting" | "listening" | "retrieving" | "analyzing" | "speaking" | "offline" | "error";

export const CORE_LABEL: Record<CoreState, string> = {
  standby: "Standby",
  starting: "Initializing",
  listening: "Listening",
  retrieving: "Retrieving",
  analyzing: "Analyzing",
  speaking: "Responding",
  offline: "Offline",
  error: "Interrupted",
};

const MOTION: Record<CoreState, { speed: number; pulse: string; ripple: boolean }> = {
  standby: { speed: 1, pulse: "3.4s", ripple: false },
  starting: { speed: 0.45, pulse: "1.2s", ripple: false },
  listening: { speed: 0.8, pulse: "1.8s", ripple: true },
  retrieving: { speed: 0.28, pulse: "0.9s", ripple: false },
  analyzing: { speed: 0.42, pulse: "1.1s", ripple: false },
  speaking: { speed: 0.65, pulse: "0.55s", ripple: true },
  offline: { speed: 3, pulse: "6s", ripple: false },
  error: { speed: 2.4, pulse: "4s", ripple: false },
};

const C = 200; // viewBox centre
const circ = (r: number) => 2 * Math.PI * r;

export function JarvisCore({ state = "standby", size = 360, className, boot = true, maxHeight }: { state?: CoreState; size?: number; className?: string; boot?: boolean; /** CSS length capping the height (e.g. on small screens); width follows. */ maxHeight?: string }) {
  const m = MOTION[state];
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tone = state === "error" ? "#f87171" : state === "offline" ? "#64748b" : "#22d3ee";
  const busy = state === "retrieving" || state === "analyzing" || state === "starting";
  const amber = busy ? "#fbbf24" : "#f59e0b";
  const spin = (d: string, rev = false, delay = "0ms") =>
    ({ className: cn("jv-ring", rev ? "jv-spin-rev" : "jv-spin"), style: { "--d": d, animationDelay: delay } as CSSProperties });
  const bootStyle = (i: number) => (boot ? ({ className: "jv-ring jv-boot", style: { animationDelay: `${i * 110}ms` } } as const) : {});

  return (
    <svg viewBox="0 0 400 400" width={size} height={size} role="img" aria-label={`JARVIS core: ${CORE_LABEL[state]}`}
      className={cn("max-w-full select-none", className)} style={{ "--jv": m.speed, ...(maxHeight ? { height: `min(${size}px, ${maxHeight})`, width: "auto" } : {}) } as CSSProperties}>
      <defs>
        <radialGradient id={`jv-core-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={tone} stopOpacity="1" />
          <stop offset="55%" stopColor={tone} stopOpacity="0.85" />
          <stop offset="100%" stopColor={tone} stopOpacity="0.25" />
        </radialGradient>
        <filter id={`jv-glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Outer dotted ring with heading markers */}
      <g {...bootStyle(0)}>
        <g {...spin("90s")}>
          <circle cx={C} cy={C} r={186} fill="none" stroke={tone} strokeOpacity="0.55" strokeWidth="2.2" strokeDasharray={`0.1 ${circ(186) / 96}`} strokeLinecap="round" />
        </g>
        <circle cx={C} cy={C} r={176} fill="none" stroke={tone} strokeOpacity="0.18" strokeWidth="1" />
        <path d={`M${C - 7} 6 L${C + 7} 6 L${C} 18 Z`} fill={tone} />
        <path d={`M${C - 7} 394 L${C + 7} 394 L${C} 382 Z`} fill={tone} />
        <line x1={14} y1={C} x2={44} y2={C} stroke={tone} strokeOpacity="0.5" strokeWidth="1.5" />
        <line x1={356} y1={C} x2={386} y2={C} stroke={tone} strokeOpacity="0.5" strokeWidth="1.5" />
      </g>

      {/* Main segmented ring */}
      <g {...bootStyle(1)}>
        <g {...spin("48s", true)}>
          <circle cx={C} cy={C} r={150} fill="none" stroke={tone} strokeWidth="7" strokeLinecap="round" strokeOpacity="0.85"
            strokeDasharray="70 26 22 38 120 30 14 46 86 34 30 40 18 60 92 30 44 52" />
        </g>
      </g>

      {/* Amber accent arcs */}
      <g {...bootStyle(2)}>
        <g {...spin("26s")}>
          <circle cx={C} cy={C} r={128} fill="none" stroke={amber} strokeWidth="3" strokeLinecap="round" strokeOpacity={busy ? 1 : 0.75}
            strokeDasharray="34 110 10 160 26 90 8 150 30 186" />
        </g>
      </g>

      {/* Inner rings */}
      <g {...bootStyle(3)}>
        <circle cx={C} cy={C} r={104} fill="none" stroke={tone} strokeOpacity="0.4" strokeWidth="1.2" />
        <g {...spin("34s", true)}>
          <circle cx={C} cy={C} r={94} fill="none" stroke={tone} strokeOpacity="0.55" strokeWidth="1.6" strokeDasharray={`0.1 ${circ(94) / 72}`} strokeLinecap="round" />
        </g>
        <g {...spin("14s")}>
          <circle cx={C} cy={C} r={82} fill="none" stroke={tone} strokeOpacity="0.9" strokeWidth="2.5" strokeDasharray={`${circ(82) * 0.22} ${circ(82) * 0.03} ${circ(82) * 0.5} ${circ(82) * 0.25}`} strokeLinecap="round" />
        </g>
      </g>

      {/* Listening / speaking ripples */}
      {m.ripple && [0, 0.73, 1.46].map((delay) => (
        <circle key={delay} cx={C} cy={C} r={70} fill="none" stroke={tone} strokeWidth="1.5" className="jv-ring jv-ripple" style={{ animationDelay: `${delay}s` }} />
      ))}

      {/* Core */}
      <g {...bootStyle(4)}>
        <circle cx={C} cy={C} r={66} fill={tone} fillOpacity="0.1" stroke={tone} strokeOpacity="0.9" strokeWidth="3" />
        <circle cx={C} cy={C} r={50} fill="#0e3a4a" fillOpacity="0.9" />
        <g className="jv-ring jv-pulse" style={{ "--pd": m.pulse } as CSSProperties}>
          <circle cx={C} cy={C} r={30} fill={`url(#jv-core-${uid})`} filter={`url(#jv-glow-${uid})`} />
        </g>
      </g>
    </svg>
  );
}

/** Voice activity bars under the core; lively while listening or speaking, low and still otherwise. */
export function JarvisWave({ active, bars = 28, className }: { active: boolean; bars?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("flex h-10 items-end justify-center gap-[4px]", className)}>
      {Array.from({ length: bars }, (_, i) => {
        const h = 35 + ((i * 37) % 65);
        return (
          <span key={i} className="w-[4px] origin-bottom rounded-sm bg-accent"
            style={active ? { height: `${h}%`, animation: `jv-bar ${0.7 + ((i * 13) % 7) / 10}s ease-in-out ${(i % 5) * 0.09}s infinite` } : { height: `${Math.max(12, h / 4)}%`, opacity: 0.45 }} />
        );
      })}
    </div>
  );
}

/** The small JARVIS mark (logo, panel headers): concentric rings with a slow turn. */
export function JarvisMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden className={cn("shrink-0", className)}>
      <g className="jv-ring jv-spin" style={{ "--d": "24s" } as CSSProperties}>
        <circle cx="20" cy="20" r="18" fill="none" stroke="#22d3ee" strokeWidth="1.6" strokeDasharray="4 3" strokeOpacity="0.8" />
      </g>
      <circle cx="20" cy="20" r="11" fill="none" stroke="#22d3ee" strokeWidth="2" />
      <circle cx="20" cy="20" r="5" fill="#22d3ee" />
    </svg>
  );
}
