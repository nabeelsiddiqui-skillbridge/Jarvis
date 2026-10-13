import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names and resolves Tailwind conflicts (later classes win, e.g. "hidden" over "inline-flex"). */
export const cn = (...v: ClassValue[]) => twMerge(clsx(v));
