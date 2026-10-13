import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Keyboard-navigable tab list (arrow keys move between tabs). */
export function Tabs<T extends string>({ value, onChange, items, className }: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="tablist" className={cn("inline-flex max-w-full gap-1 overflow-x-auto rounded-lg border border-line bg-panel-2 p-1", className)}
      onKeyDown={(e) => {
        const i = items.findIndex((x) => x.value === value);
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        const next = (i + d + items.length) % items.length;
        onChange(items[next].value);
        refs.current[next]?.focus();
      }}>
      {items.map((it, i) => (
        <button key={it.value} ref={(el) => { refs.current[i] = el; }} role="tab" aria-selected={it.value === value} tabIndex={it.value === value ? 0 : -1}
          onClick={() => onChange(it.value)}
          className={cn("shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors", it.value === value ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg")}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
