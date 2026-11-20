"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, ShieldBan, Sun, Moon } from "lucide-react";
import { SubpageNav } from "@/components/subpage-nav";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/database.types";
import { Avatar } from "@/components/ui/avatar";

type BlockedProfile = { id: string; display_name: string; username: string; avatar_url: string | null };

export default function SettingsPage() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [blocked, setBlocked] = useState<BlockedProfile[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const storedTheme = localStorage.getItem("ziza-theme");
    if (storedTheme === "light") {
      setTheme("light");
      document.body.classList.add("light-theme");
    }
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      setError("Configure Supabase in .env.local to use account settings.");
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user) {
        router.replace("/");
        return;
      }
      const [profileResult, blocksResult] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", authData.user.id).single(),
        supabase.from("blocks").select("blocked_id").eq("blocker_id", authData.user.id),
      ]);
      if (cancelled) return;
      if (profileResult.error || blocksResult.error) {
        setError(profileResult.error?.message ?? blocksResult.error?.message ?? "Could not load settings.");
        setLoading(false);
        return;
      }
      setProfile(profileResult.data);
      const ids = (blocksResult.data ?? []).map((block) => block.blocked_id);
      if (ids.length) {
        const { data: profiles, error: profilesError } = await supabase.from("profiles").select("id,display_name,username,avatar_url").in("id", ids);
        if (profilesError) setError(profilesError.message);
        else setBlocked(profiles ?? []);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [router, supabase]);

  type ProfileSettingUpdate =
    | { key: "hide_online_status"; value: boolean }
    | { key: "read_receipts_enabled"; value: boolean }
    | { key: "disappearing_messages"; value: Profile["disappearing_messages"] };

  async function updateProfile(update: ProfileSettingUpdate) {
    if (!supabase || !profile) return;
    setSaving(update.key);
    setError("");
    const result = update.key === "hide_online_status"
      ? await supabase.from("profiles").update({ hide_online_status: update.value }).eq("id", profile.id)
      : update.key === "read_receipts_enabled"
        ? await supabase.from("profiles").update({ read_receipts_enabled: update.value }).eq("id", profile.id)
        : await supabase.from("profiles").update({ disappearing_messages: update.value }).eq("id", profile.id);
    const updateError = result.error;
    if (updateError) setError(updateError.message);
    else setProfile({ ...profile, [update.key]: update.value });
    setSaving("");
  }

  function changeTheme(value: "dark" | "light") {
    setTheme(value);
    document.body.classList.toggle("light-theme", value === "light");
    localStorage.setItem("ziza-theme", value);
  }

  async function unblock(person: BlockedProfile) {
    if (!supabase) return;
    setSaving(person.id);
    const { error: unblockError } = await supabase.rpc("unblock_user", { p_user_id: person.id });
    if (unblockError) setError(unblockError.message);
    else setBlocked((current) => current.filter((entry) => entry.id !== person.id));
    setSaving("");
  }

  return (
    <main className="page-shell">
      <SubpageNav />
      <section className="subpage-content">
        <div className="subpage-title"><span className="auth-kicker">YOUR SPACE, YOUR RULES</span><h1>Privacy & settings</h1><p>Choose what you share and how Ziza feels on this device.</p></div>
        {error && <div className="inline-error" role="alert">{error}</div>}
        {loading ? <div className="settings-card"><LoaderCircle size={17} className="spin-icon" /> Loading preferences…</div> : profile && (
          <>
            <section className="settings-card">
              <h2>Privacy</h2><p>Your choices are saved to your Ziza account.</p>
              <div className="setting-row"><div><strong>Hide online status</strong><span>Others won’t see when you’re active.</span></div><button className={`toggle ${profile.hide_online_status ? "on" : ""}`} role="switch" aria-checked={profile.hide_online_status} aria-label="Hide online status" onClick={() => void updateProfile({ key: "hide_online_status", value: !profile.hide_online_status })} /></div>
              <div className="setting-row"><div><strong>Read receipts</strong><span>Let contacts know when you’ve read messages.</span></div><button className={`toggle ${profile.read_receipts_enabled ? "on" : ""}`} role="switch" aria-checked={profile.read_receipts_enabled} aria-label="Read receipts" onClick={() => void updateProfile({ key: "read_receipts_enabled", value: !profile.read_receipts_enabled })} /></div>
              <div className="setting-row"><div><strong>Default disappearing timer</strong><span>Applied to new messages you send.</span></div><select className="select-control" value={profile.disappearing_messages} onChange={(event) => { if (event.target.value === "off" || event.target.value === "24h" || event.target.value === "7d") void updateProfile({ key: "disappearing_messages", value: event.target.value }); }} aria-label="Default disappearing timer"><option value="off">Off</option><option value="24h">24 hours</option><option value="7d">7 days</option></select></div>
              {saving && <div className="saving-hint"><LoaderCircle size={13} className="spin-icon" /> Saving changes…</div>}
            </section>

            <section className="settings-card">
              <h2>Appearance</h2><p>Theme is stored on this device only.</p>
              <div className="setting-row"><div><strong>Color theme</strong><span>Dark-first, with a bright light mode.</span></div><div className="theme-options"><button className={theme === "dark" ? "active" : ""} onClick={() => changeTheme("dark")}><Moon size={13} /> Dark</button><button className={theme === "light" ? "active" : ""} onClick={() => changeTheme("light")}><Sun size={13} /> Light</button></div></div>
            </section>

            <section className="settings-card">
              <h2>Blocked accounts</h2><p>Blocked people can’t send you requests or see your stories and presence.</p>
              {blocked.length ? blocked.map((person) => <div className="blocked-row" key={person.id}><Avatar name={person.display_name} url={person.avatar_url} /><div className="request-copy"><strong>{person.display_name}</strong><span>@{person.username}</span></div><button className="secondary-button" onClick={() => void unblock(person)} disabled={saving === person.id}>{saving === person.id ? <LoaderCircle size={13} className="spin-icon" /> : <Check size={14} />} Unblock</button></div>) : <div className="settings-empty"><ShieldBan size={15} /> No blocked accounts.</div>}
            </section>

            <div className="security-note"><ShieldBan size={15} /><span>Account passwords are separate from device settings. Avoid using a 4-digit PIN as your account password.</span></div>
          </>
        )}
      </section>
    </main>
  );
}
