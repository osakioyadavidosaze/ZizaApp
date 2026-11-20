"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock3, ImagePlus, LoaderCircle, Send, Sparkles } from "lucide-react";
import { SubpageNav } from "@/components/subpage-nav";
import { Avatar } from "@/components/ui/avatar";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Profile, Story } from "@/lib/database.types";

type StoryView = Story & { person: Profile & Record<string, unknown>; signedUrl: string | null; remainingMs: number };

export default function StoriesPage() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const [userId, setUserId] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stories, setStories] = useState<StoryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadStories = useCallback(async () => {
    if (!supabase) {
      throw new Error("Configure Supabase in .env.local to use stories.");
    }
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError) throw authError;
    if (!authData.user) {
      if (mountedRef.current) router.replace("/");
      return;
    }

    const { data: rows, error: storiesError } = await supabase
      .from("stories")
      .select("*")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    if (storiesError) throw storiesError;

    const ids = [...new Set((rows ?? []).map((story) => story.user_id))];
    const profilesResult = ids.length
      ? await supabase.from("profiles").select("*").in("id", ids)
      : { data: [], error: null };
    if (profilesResult.error) throw profilesResult.error;

    const profileMap = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
    const storyViews = (await Promise.all((rows ?? []).map(async (story) => {
      const person = profileMap.get(story.user_id);
      if (!person) return null;
      let signedUrl: string | null = null;
      if (story.media_path) {
        const { data, error: signedUrlError } = await supabase.storage.from("story-media").createSignedUrl(story.media_path, 15 * 60);
        if (signedUrlError) throw signedUrlError;
        signedUrl = data.signedUrl;
      }
      return { ...story, person, signedUrl, remainingMs: Math.max(0, new Date(story.expires_at).getTime() - Date.now()) };
    }))).filter((story): story is StoryView => story !== null);

    if (mountedRef.current) {
      setUserId(authData.user.id);
      setStories(storyViews);
      setLoading(false);
    }
  }, [router, supabase]);

  useEffect(() => {
    const refresh = () => {
      void loadStories().catch((caught: unknown) => {
        if (mountedRef.current) {
          setError(caught instanceof Error ? caught.message : "Could not load stories.");
          setLoading(false);
        }
      });
    };
    refresh();

    if (!supabase) return;
    const channel = supabase
      .channel("ziza:stories")
      .on("postgres_changes", { event: "*", schema: "public", table: "stories" }, refresh)
      .subscribe((status) => {
        if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT") && mountedRef.current) {
          setError("Live story updates are unavailable. Check your Supabase Realtime configuration.");
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadStories, supabase]);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!selected) return;
    if (!selected.type.startsWith("image/")) {
      setError("Stories currently support image files only.");
      return;
    }
    if (selected.size > 10 * 1024 * 1024) {
      setError("Story images must be 10 MB or smaller.");
      return;
    }
    setError("");
    setFile(selected);
  }

  async function publishStory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !userId || posting) return;
    if (!text.trim() && !file) {
      setError("Write a short update or choose a photo.");
      return;
    }
    setPosting(true);
    setError("");
    let mediaPath: string | null = null;
    if (file) {
      mediaPath = `${userId}/${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80)}`;
      const { error: uploadError } = await supabase.storage.from("story-media").upload(mediaPath, file, { contentType: file.type, upsert: false });
      if (uploadError) {
        setPosting(false);
        setError(uploadError.message);
        return;
      }
    }
    const { error: insertError } = await supabase.from("stories").insert({
      user_id: userId,
      type: file ? "image" : "text",
      content: text.trim() || null,
      media_path: mediaPath,
    });
    setPosting(false);
    if (insertError) {
      setError(`Your story could not be published: ${insertError.message}`);
      return;
    }
    setText("");
    setFile(null);
    try {
      await loadStories();
    } catch (caught) {
      setError(caught instanceof Error ? `Story posted, but the list could not refresh: ${caught.message}` : "Story posted, but the list could not refresh.");
    }
  }

  const myStories = stories.filter((story) => story.user_id === userId);
  const contactStories = stories.filter((story) => story.user_id !== userId);

  return (
    <main className="page-shell">
      <SubpageNav />
      <section className="subpage-content">
        <div className="subpage-title"><span className="auth-kicker">A LITTLE WINDOW INTO YOUR DAY</span><h1>Ziza Stories</h1><p>Share a moment with your accepted contacts. Stories disappear after 24 hours.</p></div>
        {error && <div className="inline-error" role="alert">{error}</div>}
        <form className="story-form" onSubmit={(event) => void publishStory(event)}>
          <label className="story-field-label" htmlFor="story-text">Share a thought</label>
          <textarea id="story-text" maxLength={280} placeholder="What’s happening in your world?" value={text} onChange={(event) => setText(event.target.value)} />
          <div className="story-form-actions">
            <div><label className="story-file-button"><ImagePlus size={14} />{file ? file.name : "Add a photo"}<input type="file" accept="image/*" onChange={(event) => void handleFileChange(event)} /></label>{file && <button className="remove-file" type="button" onClick={() => setFile(null)}>Remove</button>}<span className="story-counter">{text.length}/280</span></div>
            <button type="submit" className="primary-button" disabled={posting}>{posting ? <LoaderCircle size={14} className="spin-icon" /> : <Send size={14} />} Share story</button>
          </div>
        </form>

        <div className="stories-section-title"><div><Sparkles size={16} /><h2>From your circle</h2></div><span>Visible to accepted contacts</span></div>
        {loading ? <div className="settings-card"><LoaderCircle size={16} className="spin-icon" /> Loading stories…</div> : contactStories.length ? <div className="story-grid">{contactStories.map((story) => <StoryCard key={story.id} story={story} />)}</div> : <div className="stories-empty">No stories yet. When your accepted contacts share a moment, you’ll find it here.</div>}

        {myStories.length > 0 && <><div className="stories-section-title my-stories-title"><div><Clock3 size={15} /><h2>Your active stories</h2></div></div><div className="story-grid">{myStories.map((story) => <StoryCard key={story.id} story={story} />)}</div></>}
      </section>
    </main>
  );
}

function StoryCard({ story }: { story: StoryView }) {
  const remaining = story.remainingMs;
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  return (
    <article className="story-card">
      <div className="story-author"><Avatar name={story.person.display_name} url={story.person.avatar_url} /><span><strong>{story.person.display_name}</strong><small>{hours ? `${hours}h left` : "Less than an hour left"}</small></span></div>
      {story.signedUrl && <img className="story-image" src={story.signedUrl} alt={`Story from ${story.person.display_name}`} />}
      {story.content && <p>{story.content}</p>}
      <span className="story-created">{new Date(story.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
    </article>
  );
}
