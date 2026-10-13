import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { History, MessageSquare, SquarePen, Trash2 } from "lucide-react";
import { del, errorMessage } from "@/lib/api";
import { useBusiness } from "@/lib/business";
import { assistantKeys, useConversations } from "@/lib/assistant";
import { cn } from "@/lib/cn";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/components/widgets/WidgetFrame";
import { Chat } from "@/components/assistant/Chat";

/** Full-page assistant: conversation history + chat. Full-screen on phones. */
export function Assistant() {
  const b = useBusiness();
  const [params, setParams] = useSearchParams();
  const conversationId = params.get("c");
  const [historyOpen, setHistoryOpen] = useState(false);
  const select = (id: string | null) => { setParams(id ? { c: id } : {}, { replace: !id }); setHistoryOpen(false); };

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Conversations" className="hidden w-[280px] shrink-0 flex-col border-r border-line bg-panel-2/40 lg:flex">
        <ConversationList current={conversationId} onSelect={select} />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4 lg:hidden">
          <h1 className="font-display text-sm font-semibold">AI Assistant</h1>
          <div className="flex items-center gap-1">
            <IconButton label="Conversation history" size="sm" onClick={() => setHistoryOpen(true)}><History className="size-4" /></IconButton>
            <IconButton label="New conversation" size="sm" onClick={() => select(null)}><SquarePen className="size-4" /></IconButton>
          </div>
        </div>
        <Chat key={b.id} business={b} conversationId={conversationId} onConversation={(id) => setParams({ c: id }, { replace: true })} onMissing={() => select(null)} />
      </section>
      <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} title="Conversations">
        <div className="-mx-2 max-h-[60vh] overflow-y-auto"><ConversationList current={conversationId} onSelect={select} /></div>
      </Dialog>
    </div>
  );
}

function ConversationList({ current, onSelect }: { current: string | null; onSelect: (id: string | null) => void }) {
  const b = useBusiness();
  const list = useConversations(b.id);
  const qc = useQueryClient();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: (id: string) => del(`/businesses/${b.id}/assistant/conversations/${id}`),
    onSuccess: (_r, id) => {
      qc.invalidateQueries({ queryKey: assistantKeys.conversations(b.id) });
      if (id === current) onSelect(null);
      toast("Conversation deleted");
    },
    onError: (e) => toast(errorMessage(e), "error"),
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-3">
        <Button variant="secondary" className="w-full" icon={<SquarePen className="size-4" />} onClick={() => onSelect(null)}>New conversation</Button>
      </div>
      <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">History · {b.name}</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {list.isLoading ? <div className="p-4"><Spinner label="Loading" /></div>
          : !list.data?.length ? <p className="px-2 py-3 text-[13px] text-subtle">No conversations yet. Only you can see your conversations.</p>
          : (
            <ul className="space-y-0.5">
              {list.data.map((c) => (
                <li key={c.id} className="group relative">
                  <button type="button" onClick={() => onSelect(c.id)} aria-current={c.id === current ? "page" : undefined}
                    className={cn("flex w-full items-start gap-2 rounded-lg px-2.5 py-2 pr-9 text-left text-[13px] transition-colors", c.id === current ? "bg-accent/10 text-fg" : "text-muted hover:bg-white/5 hover:text-fg")}>
                    <MessageSquare className="mt-0.5 size-4 shrink-0 opacity-70" aria-hidden />
                    <span className="min-w-0"><span className="block truncate">{c.title}</span><span className="text-[11px] text-subtle">{relativeTime(c.updatedAt)}</span></span>
                  </button>
                  <IconButton label={`Delete "${c.title}"`} size="sm" className="absolute right-1 top-1.5 opacity-60 hover:opacity-100 focus-visible:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
                    onClick={() => { if (confirm("Delete this conversation? This can't be undone.")) remove.mutate(c.id); }}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  );
}
