"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { ArrowRight, Check, Copy, LockKeyhole, MessageCircle, QrCode, ShieldCheck, Sparkles } from "lucide-react";
import { authAliasForUsername, formatZizaNumber, getSupabaseConfigError, normalizeZizaNumber, usernameSchema } from "@/lib/auth";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/database.types";

type AuthMode = "login" | "signup";

export function AuthScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("signup");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newProfile, setNewProfile] = useState<Profile | null>(null);
  const [copied, setCopied] = useState(false);

  const configError = getSupabaseConfigError();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (configError) {
      setError(configError);
      return;
    }

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError("Supabase is not configured. Add the environment variables and reload.");
      return;
    }

    setBusy(true);
    try {
      if (mode === "signup") {
        const parsedUsername = usernameSchema.safeParse(username);
        if (!parsedUsername.success) {
          setError(parsedUsername.error.issues[0]?.message ?? "Enter a valid username.");
          return;
        }
        if (displayName.trim().length < 1 || displayName.trim().length > 60) {
          setError("Display name must be between 1 and 60 characters.");
          return;
        }
        if (password.length < 12) {
          setError("Use a password with at least 12 characters.");
          return;
        }

        const { data, error: signUpError } = await supabase.auth.signUp({
          email: authAliasForUsername(parsedUsername.data),
          password,
          options: { data: { username: parsedUsername.data, display_name: displayName.trim() } },
        });
        if (signUpError) throw signUpError;
        if (!data.session || !data.user) {
          setError("Account created, but no session was returned. Disable email confirmation in Supabase Auth for username-only accounts, then try logging in.");
          return;
        }

        const { data: profile, error: profileError } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", data.user.id)
          .single();
        if (profileError) throw profileError;
        setNewProfile(profile);
      } else {
        const response = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: identifier.trim(), password }),
        });
        const result: { error?: string } = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Unable to sign in.");
        await supabase.auth.getSession();
        router.push("/chat");
        router.refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copyNumber() {
    if (!newProfile) return;
    await navigator.clipboard.writeText(formatZizaNumber(newProfile.ziza_number));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  function downloadQr() {
    const svg = document.querySelector<SVGSVGElement>("#ziza-number-qr");
    if (!svg || !newProfile) return;
    const source = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ziza-${newProfile.ziza_number}.svg`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="auth-page">
      <section className="auth-hero">
        <div className="hero-glow hero-glow-one" />
        <div className="hero-glow hero-glow-two" />
        <Link className="brand-lockup" href="/" aria-label="Ziza home">
          <span className="brand-mark"><MessageCircle size={23} strokeWidth={2.6} /></span>
          <span>Ziza<span className="brand-dot">.</span></span>
        </Link>
        <div className="hero-content">
          <div className="eyebrow"><span className="eyebrow-dot" /> YOUR SPACE. YOUR PEOPLE.</div>
          <h1>Closer, without<br /><span>the noise.</span></h1>
          <p className="hero-copy">A quieter kind of connection. No phone number, no public directory—just you and the people you choose.</p>
          <div className="hero-points">
            <div><span className="point-icon"><ShieldCheck size={17} /></span><span><b>Private by design</b><small>Your Ziza Number is yours alone</small></span></div>
            <div><span className="point-icon"><LockKeyhole size={17} /></span><span><b>End-to-end focused</b><small>Your conversations stay personal</small></span></div>
            <div><span className="point-icon"><Sparkles size={17} /></span><span><b>Made for your circle</b><small>Find friends only by their number</small></span></div>
          </div>
        </div>
        <div className="hero-footer"><span>© 2026 Ziza</span><span>Connection, on your terms.</span></div>
      </section>

      <section className="auth-side">
        <div className="auth-card">
          <div className="mobile-brand"><span className="brand-mark"><MessageCircle size={21} /></span><b>Ziza<span className="brand-dot">.</span></b></div>
          <div className="auth-heading">
            <span className="auth-kicker">{mode === "signup" ? "YOUR CIRCLE STARTS HERE" : "WELCOME BACK"}</span>
            <h2>{mode === "signup" ? "Create your account" : "Good to see you"}</h2>
            <p>{mode === "signup" ? "No number needed. Just make it yours." : "Your people are right where you left them."}</p>
          </div>

          <div className="auth-tabs" role="tablist" aria-label="Account action">
            <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setError(""); }}>Create account</button>
            <button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); }}>Log in</button>
          </div>

          <form onSubmit={handleSubmit} className="auth-form">
            {mode === "signup" ? (
              <>
                <label className="field-label" htmlFor="display-name">Display name</label>
                <input id="display-name" autoComplete="name" maxLength={60} placeholder="How should friends see you?" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
                <label className="field-label" htmlFor="username">Username</label>
                <div className="input-prefix"><span>@</span><input id="username" autoComplete="username" maxLength={24} placeholder="yourname" value={username} onChange={(event) => setUsername(event.target.value)} required /></div>
                <label className="field-label" htmlFor="password">Password</label>
                <input id="password" type="password" autoComplete="new-password" minLength={12} placeholder="At least 12 characters" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="identifier">Username or Ziza Number</label>
                <input id="identifier" autoComplete="username" placeholder="username or 000-000-0000" value={identifier} onChange={(event) => setIdentifier(event.target.value)} required />
                <label className="field-label" htmlFor="password">Password</label>
                <input id="password" type="password" autoComplete="current-password" placeholder="Your password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </>
            )}

            {error && <div className="form-alert" role="alert">{error}</div>}
            <button className="primary-button auth-submit" type="submit" disabled={busy}>
              {busy ? <span className="button-spinner" /> : <>{mode === "signup" ? "Create my account" : "Log in securely"} <ArrowRight size={17} /></>}
            </button>
          </form>

          <div className="auth-note"><LockKeyhole size={14} /><span>Your account isn’t linked to a phone number or real email.</span></div>
          <div className="auth-divider"><span /> PRIVATE BY DEFAULT <span /></div>
        </div>
        <p className="auth-legal">By continuing, you agree to keep your circle respectful and safe.</p>
      </section>

      {newProfile && (
        <div className="modal-backdrop" role="presentation">
          <section className="number-modal" role="dialog" aria-modal="true" aria-labelledby="number-title">
            <div className="success-orbit"><span><Check size={27} /></span></div>
            <span className="auth-kicker">ACCOUNT CREATED</span>
            <h2 id="number-title">Your Ziza Number</h2>
            <p>This is your private key to finding friends. Save it somewhere safe.</p>
            <div className="number-display">{formatZizaNumber(newProfile.ziza_number)}</div>
            <div className="qr-card">
              <QRCodeSVG id="ziza-number-qr" value={`https://ziza.app/add/${newProfile.ziza_number}`} size={150} level="M" includeMargin />
              <span><QrCode size={14} /> Scan to find me on Ziza</span>
            </div>
            <div className="number-actions">
              <button className="secondary-button" type="button" onClick={copyNumber}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copied" : "Copy number"}</button>
              <button className="primary-button" type="button" onClick={downloadQr}>Download QR</button>
            </div>
            <button className="text-button continue-button" type="button" onClick={() => router.push("/chat")}>Continue to Ziza <ArrowRight size={15} /></button>
          </section>
        </div>
      )}
    </main>
  );
}
