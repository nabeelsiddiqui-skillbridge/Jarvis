import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { cn } from "@/lib/cn";
import { post } from "@/lib/api";
import { k, useNotifications } from "@/lib/insights";
import { Popover } from "@/components/ui/Popover";
import { relativeTime } from "@/components/widgets/WidgetFrame";

/** In-app notifications across the user's businesses (alerts, briefings, approvals). */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const q = useNotifications();
  const qc = useQueryClient();
  const nav = useNavigate();
  const read = useMutation({ mutationFn: (id: string) => post(`/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: k.notifications }) });
  const readAll = useMutation({ mutationFn: () => post(`/notifications/read-all`), onSuccess: () => qc.invalidateQueries({ queryKey: k.notifications }) });
  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative">
      <button ref={ref} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)} aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        className="relative inline-grid size-10 place-items-center rounded-lg text-muted hover:bg-white/5 hover:text-fg">
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-bold leading-4 text-[#04121a]">{unread > 9 ? "9+" : unread}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} align="end" className="w-[min(380px,calc(100vw-24px))] p-0">
        <div role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && <button type="button" onClick={() => readAll.mutate()} className="text-xs text-accent hover:underline">Mark all read</button>}
          </div>
          {!q.data?.items.length ? <p className="px-4 py-6 text-center text-sm text-muted">You're all caught up. Alerts, briefings and approval requests appear here.</p> : (
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {q.data.items.map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => { if (!n.readAt) read.mutate(n.id); setOpen(false); if (n.link) nav(n.link); }}
                    className={cn("flex w-full gap-3 px-4 py-2.5 text-left hover:bg-white/5", !n.readAt && "bg-accent/[0.04]")}>
                    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-accent")} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-fg">{n.title}</span>
                      {n.body && <span className="line-clamp-2 text-[13px] text-muted">{n.body}</span>}
                      <span className="text-[11px] text-subtle">{n.businessName} · {relativeTime(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Popover>
    </div>
  );
}
