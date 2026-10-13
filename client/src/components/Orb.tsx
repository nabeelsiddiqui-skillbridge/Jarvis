export type OrbState = "idle" | "listening" | "thinking" | "speaking";

/** The arc-reactor core. Rings spin faster and glow brighter as JARVIS gets busier. */
export function Orb({ state, onClick, size = 168 }: { state: OrbState; onClick?: () => void; size?: number }) {
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  return (
    <button className={`orb orb--${state}`} style={{ width: size, height: size }} onClick={onClick} aria-label={`JARVIS core — ${state}. Click to talk.`}>
      <svg viewBox="0 0 200 200" aria-hidden>
        <defs>
          <radialGradient id="core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ecfeff" />
            <stop offset="35%" stopColor="#67e8f9" />
            <stop offset="70%" stopColor="#0891b2" stopOpacity=".5" />
            <stop offset="100%" stopColor="#0891b2" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g className="orb__ticks">
          {ticks.map((i) => (
            <line key={i} x1="100" y1="6" x2="100" y2={i % 5 ? 12 : 16} transform={`rotate(${i * 6} 100 100)`} />
          ))}
        </g>
        <circle className="orb__ring orb__ring--a" cx="100" cy="100" r="78" />
        <circle className="orb__ring orb__ring--b" cx="100" cy="100" r="64" />
        <circle className="orb__ring orb__ring--c" cx="100" cy="100" r="50" />
        <g className="orb__segments">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <rect key={i} x="96" y="40" width="8" height="14" rx="2" transform={`rotate(${i * 45} 100 100)`} />
          ))}
        </g>
        <circle className="orb__core" cx="100" cy="100" r="34" fill="url(#core)" />
      </svg>
      <span className="orb__label">{state === "idle" ? "ONLINE" : state.toUpperCase()}</span>
    </button>
  );
}
