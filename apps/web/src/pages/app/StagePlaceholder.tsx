import { Construction } from "lucide-react";
import { PageHeader } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { useOptionalBusiness } from "@/lib/business";

/** Shown for areas scheduled for a later build stage, so no control silently does nothing. */
export function StagePlaceholder({ area, stage }: { area: string; stage: number }) {
  const b = useOptionalBusiness();
  return (
    <>
      <PageHeader title={area} description={b ? `For ${b.name}` : undefined} />
      <EmptyState icon={<Construction className="size-5" />} title={`${area} is delivered in build stage ${stage}`}>
        This area isn't functional yet. It's scheduled for stage {stage} of the build, and nothing on this page simulates data in the meantime.
      </EmptyState>
    </>
  );
}
