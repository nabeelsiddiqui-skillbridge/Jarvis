import { ButtonLink } from "@/components/ui/Button";
import { Logo } from "@/components/brand/Logo";

export function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-6 text-center">
      <div>
        <Logo className="mb-8 justify-center" />
        <p className="font-display text-6xl font-semibold text-gradient">404</p>
        <p className="mt-3 text-muted">This page doesn't exist, or you don't have access to it.</p>
        <ButtonLink to="/app" variant="primary" className="mt-6">Back to the app</ButtonLink>
      </div>
    </div>
  );
}
