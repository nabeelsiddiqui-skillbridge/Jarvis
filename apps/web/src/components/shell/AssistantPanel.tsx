import { useState } from "react";
import { Bot, Maximize2, SquarePen, X } from "lucide-react";
import type { Business } from "@bca/shared";
import { IconButton } from "@/components/ui/Button";
import { Chat } from "@/components/assistant/Chat";
import { useNavigate } from "react-router";

const storeKey = (businessId: string) => `bca.assistant.panel.${businessId}`;
const load = (businessId: string) => { try { return localStorage.getItem(storeKey(businessId)); } catch { return null; } };
const save = (businessId: string, id: string | null) => { try { id ? localStorage.setItem(storeKey(businessId), id) : localStorage.removeItem(storeKey(businessId)); } catch { /* storage unavailable */ } };

/** Right-hand assistant panel (desktop). Scoped to the active business; remounted on a business switch. */
export function AssistantPanel({ business, onClose }: { business: Business; onClose: () => void }) {
  const [conversationId, setConversationId] = useState<string | null>(() => load(business.id));
  const nav = useNavigate();
  const select = (id: string | null) => { setConversationId(id); save(business.id, id); };
  return (
    <aside aria-label="Assistant" className="hidden w-[400px] shrink-0 flex-col border-l border-line bg-panel-2/60 xl:flex">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent/30 to-violet/30 text-accent"><Bot className="size-4" /></span>
          <span className="truncate">Assistant · <span className="font-normal text-muted">{business.name}</span></span>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton label="New conversation" size="sm" onClick={() => select(null)} disabled={!conversationId}><SquarePen className="size-4" /></IconButton>
          <IconButton label="Open full assistant" size="sm" onClick={() => nav(`/app/b/${business.id}/assistant${conversationId ? `?c=${conversationId}` : ""}`)}><Maximize2 className="size-4" /></IconButton>
          <IconButton label="Hide assistant" size="sm" onClick={onClose}><X className="size-4" /></IconButton>
        </div>
      </div>
      <Chat key={business.id} business={business} conversationId={conversationId} onConversation={(id) => select(id)} onMissing={() => select(null)} compact />
    </aside>
  );
}
