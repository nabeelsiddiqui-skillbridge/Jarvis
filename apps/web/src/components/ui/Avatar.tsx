import { useState } from "react";
import { cn } from "@/lib/cn";

const hues = ["from-cyan-400 to-sky-600", "from-violet-500 to-fuchsia-600", "from-emerald-400 to-teal-600", "from-amber-400 to-orange-600", "from-rose-400 to-pink-600", "from-indigo-400 to-blue-600"];

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
}

export function BusinessAvatar({ name, logoUrl, size = 32, className }: { name: string; logoUrl?: string | null; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const hue = hues[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length];
  if (logoUrl && !broken) {
    return <img src={logoUrl} alt="" width={size} height={size} onError={() => setBroken(true)} className={cn("shrink-0 rounded-lg bg-white object-contain p-0.5", className)} style={{ width: size, height: size }} />;
  }
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center rounded-lg bg-gradient-to-br font-display font-semibold text-white", hue, className)} style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {initials(name)}
    </span>
  );
}

export function UserAvatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full border border-line bg-raised font-medium text-fg" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials(name)}
    </span>
  );
}
