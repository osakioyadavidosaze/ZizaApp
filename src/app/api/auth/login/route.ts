import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authAliasForUsername, normalizeZizaNumber, usernameSchema } from "@/lib/auth";
import type { Database } from "@/lib/database.types";
import { authCookieOptions } from "@/lib/supabase/cookie-options";

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export async function POST(request: Request) {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid username or Ziza Number and password." }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return NextResponse.json({ error: "Supabase is not configured on this server." }, { status: 503 });
  }

  let username = parsed.data.identifier;
  const zizaNumber = normalizeZizaNumber(username);
  if (zizaNumber) {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      return NextResponse.json({ error: "Ziza Number login is not configured. Contact the app administrator." }, { status: 503 });
    }
    const admin = createClient<Database>(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await admin.from("profiles").select("username").eq("ziza_number", zizaNumber).maybeSingle();
    if (error || !data) {
      return NextResponse.json({ error: "Invalid username/Ziza Number or password." }, { status: 401 });
    }
    username = data.username;
  }

  const parsedUsername = usernameSchema.safeParse(username);
  if (!parsedUsername.success) {
    return NextResponse.json({ error: "Invalid username/Ziza Number or password." }, { status: 401 });
  }

  const cookieStore = await cookies();
  const supabase = createServerClient<Database>(url, anonKey, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
      },
    },
  });

  const { error } = await supabase.auth.signInWithPassword({
    email: authAliasForUsername(parsedUsername.data),
    password: parsed.data.password,
  });
  if (error) {
    return NextResponse.json({ error: "Invalid username/Ziza Number or password." }, { status: 401 });
  }
  return NextResponse.json({ success: true });
}
