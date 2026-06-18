import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Stable client idempotency key (per form open). */
export function newToken(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `t_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  }
}
