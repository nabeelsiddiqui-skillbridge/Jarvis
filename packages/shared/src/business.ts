import { z } from "zod";

export const INDUSTRIES = [
  { id: "ecommerce", label: "Ecommerce / retail" },
  { id: "saas", label: "SaaS / software" },
  { id: "agency", label: "Agency / services" },
  { id: "local_services", label: "Local services" },
  { id: "b2b", label: "B2B / professional services" },
  { id: "media", label: "Media / publishing" },
  { id: "nonprofit", label: "Nonprofit" },
  { id: "other", label: "Other" },
] as const;
export type IndustryId = (typeof INDUSTRIES)[number]["id"];

/** ISO 4217 currencies offered for reporting. */
export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "INR", "PKR", "AED", "SAR", "SGD", "JPY", "CHF", "SEK", "NOK", "DKK", "BRL", "MXN", "ZAR"] as const;

export const isValidTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .transform((s) => (s && !/^https?:\/\//i.test(s) ? `https://${s}` : s))
  .pipe(z.union([z.literal(""), z.url({ protocol: /^https?$/ })]))
  .optional();

export const businessInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  logoUrl: optionalUrl,
  industry: z.enum(INDUSTRIES.map((i) => i.id) as [IndustryId, ...IndustryId[]]),
  website: optionalUrl,
  timezone: z.string().refine(isValidTimezone, "Unknown timezone"),
  currency: z.enum(CURRENCIES),
  description: z.string().trim().max(2000).optional(),
});
export type BusinessInput = z.infer<typeof businessInput>;

export const goalInput = z.object({
  title: z.string().trim().min(1).max(200),
  metricKey: z.string().max(80).nullable().optional(),
  targetValue: z.number().finite().nullable().optional(),
  period: z.enum(["month", "quarter", "year"]).default("month"),
  notes: z.string().trim().max(1000).optional(),
});
export type GoalInput = z.infer<typeof goalInput>;

export interface Business {
  id: string;
  workspaceId: string;
  name: string;
  logoUrl: string | null;
  industry: IndustryId;
  website: string | null;
  timezone: string;
  currency: string;
  description: string | null;
  isDemo: boolean;
  createdAt: string;
  role: "owner" | "admin" | "analyst" | "viewer";
  /** Viewing through a platform administrator's read-only support grant (not a member). */
  support?: boolean;
}

export interface Goal {
  id: string;
  businessId: string;
  title: string;
  metricKey: string | null;
  targetValue: number | null;
  period: "month" | "quarter" | "year";
  notes: string | null;
  confirmedByUser: boolean;
  createdAt: string;
}
