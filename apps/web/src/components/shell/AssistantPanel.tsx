import type { Business } from "@bca/shared";
import { Bot, X } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { Prerequisite } from "@/components/ui/EmptyState";

/** Right-hand assistant panel. The conversational assistant is implemented in Stage 5. */
export function AssistantPanel({ business, onClose }: { business: Business; onClose: () => void }) {
  return (
    <aside aria-label="Assistant" className="hidden w-[380px] shrink-0 flex-col border-l border-line bg-panel-2/60 xl:flex">
      <div className="flex h-14 items-center justify-between border-b border-line px-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-accent/30 to-violet/30 text-accent"><Bot className="size-4" /></span>
          Assistant · <span className="truncate font-normal text-muted">{business.name}</span>
        </div>
        <IconButton label="Hide assistant" size="sm" onClick={onClose}><X className="size-4" /></IconButton>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <Prerequisite title="Assistant not available yet">
          The text and voice assistant is delivered in Stage 5–6 of the build. It will answer questions about <b className="text-fg">{business.name}</b> only, with sources and date ranges.
        </Prerequisite>
      </div>
    </aside>
  );
}
