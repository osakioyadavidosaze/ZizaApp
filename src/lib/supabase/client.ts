"use client";

import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { authCookieOptions } from "@/lib/supabase/cookie-options";

let browserClient: SupabaseClient<Database> | null = null;
let resumeListenersRegistered = false;

function startAuthAutoRefresh(client: SupabaseClient<Database>) {
  void client.auth.startAutoRefresh().catch((error: unknown) => {
    console.error("Could not resume Supabase auth token refresh.", error);
  });
}

function registerResumeListeners(client: SupabaseClient<Database>) {
  if (resumeListenersRegistered || typeof window === "undefined") return;
  resumeListenersRegistered = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") startAuthAutoRefresh(client);
  });

  if (Capacitor.isNativePlatform()) {
    void App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) startAuthAutoRefresh(client);
    }).catch((error: unknown) => {
      console.error("Could not register the Capacitor app resume listener.", error);
    });
  }
}

export function getSupabaseBrowserClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  browserClient ??= createBrowserClient<Database>(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
    },
    cookieOptions: authCookieOptions,
  });
  registerResumeListeners(browserClient);
  return browserClient;
}
