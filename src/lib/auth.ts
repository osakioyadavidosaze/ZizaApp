import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(24, "Username must be 24 characters or fewer")
  .regex(/^[A-Za-z0-9_]+$/, "Use only letters, numbers, and underscores");

export const formatZizaNumber = (number: string): string => {
  const digits = number.replace(/\D/g, "").slice(0, 10);
  if (digits.length !== 10) return number;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
};

export const normalizeZizaNumber = (value: string): string | null => {
  const digits = value.replace(/-/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
};

export const authAliasForUsername = (username: string): string =>
  `${username.trim().toLowerCase()}@login.ziza.invalid`;

export const getSupabaseConfigError = (): string | null => {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return "Add your Supabase URL and anon key to .env.local, then restart the dev server.";
  }
  return null;
};
