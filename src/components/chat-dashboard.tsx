"use client";

import { ChangeEvent, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown, ArrowLeft, ArrowRight, Check, CheckCheck, Clock3, FileText, Flame,
  LockKeyhole, LogOut, MessageCircle, MoreHorizontal, Paperclip, Plus,
  Search, Send, Settings2, ShieldBan, Smile, Sparkles, Sticker, X, Mic, Square, Copy,
} from "lucide-react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { formatZizaNumber } from "@/lib/auth";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Contact, Conversation, Message, Profile, Streak } from "@/lib/database.types";
import { ContactSearchDialog } from "@/components/contact-search-dialog";
import { Avatar } from "@/components/ui/avatar";

type ChatView = {
  conversation: Conversation;
  person: Profile;
  lastMessage: Message | null;
  streak: Streak | null;
  unread: number;
  lastReadAt: string;
};

type MessageView = Message & {
  mediaUrl: string | null;
  reactions: Array<{ emoji: string; user_id: string }>;
  read: boolean;
  status?: "sending" | "sent" | "failed";
};

const QUICK_EMOJIS = ["😀", "😂", "🥹", "😍", "🔥", "💜", "👏", "✨", "👍", "❤️", "🎉", "🙏"];

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "Z";
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  return "id" in value
    && typeof value.id === "string"
    && "client_id" in value
    && (value.client_id === null || typeof value.client_id === "string")
    && "conversation_id" in value
    && typeof value.conversation_id === "string"
    && "sender_id" in value
    && typeof value.sender_id === "string"
    && "reply_to_id" in value
    && (value.reply_to_id === null || typeof value.reply_to_id === "string")
    && "type" in value
    && (value.type === "text" || value.type === "image" || value.type === "document" || value.type === "voice")
    && "body" in value
    && (value.body === null || typeof value.body === "string")
    && "media_path" in value
    && (value.media_path === null || typeof value.media_path === "string")
    && "created_at" in value
    && typeof value.created_at === "string"
    && "edited_at" in value
    && (value.edited_at === null || typeof value.edited_at === "string")
    && "deleted_at" in value
    && (value.deleted_at === null || typeof value.deleted_at === "string")
    && "expires_at" in value
    && (value.expires_at === null || typeof value.expires_at === "string");
}

function timeLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function streakState(streak: Streak | null) {
  if (!streak?.expires_at) return { count: 0, warning: false };
  const expires = new Date(streak.expires_at).getTime();
  const remaining = expires - Date.now();
  return {
    count: remaining > 0 ? streak.current_count : 0,
    warning: remaining > 0 && remaining <= 4 * 60 * 60 * 1000,
  };
}

function sortMessages(messages: MessageView[]) {
  return messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

function upsertMessageList(messages: MessageView[], incoming: MessageView) {
  const index = messages.findIndex((message) =>
    message.id === incoming.id
    || (incoming.client_id !== null && message.client_id === incoming.client_id),
  );
  const next = [...messages];
  if (index === -1) {
    next.push(incoming);
  } else {
    const existing = next[index];
    next[index] = {
      ...existing,
      ...incoming,
      mediaUrl: incoming.mediaUrl ?? existing.mediaUrl,
      reactions: incoming.reactions.length ? incoming.reactions : existing.reactions,
      read: incoming.read || existing.read,
      status: incoming.status ?? existing.status,
    };
  }
  return sortMessages(next);
}

export function ChatDashboard() {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [chats, setChats] = useState<ChatView[]>([]);
  const [pending, setPending] = useState<Array<{ contact: Contact; person: Profile }>>([]);
  const [outgoing, setOutgoing] = useState<Array<{ contact: Contact; person: Profile }>>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [listMode, setListMode] = useState<"chats" | "requests">("chats");
  const [realtimeRetry, setRealtimeRetry] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState<MessageView | null>(null);
  const [editingId, setEditingId] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [online, setOnline] = useState(false);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunks = useRef<Blob[]>([]);
  const recordTimer = useRef<number | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeIdRef = useRef(activeId);
  const mobileChatOpenRef = useRef(mobileChatOpen);
  const messagesCacheRef = useRef(new Map<string, MessageView[]>());
  const pendingSendsRef = useRef(new Set<string>());

  const selectConversation = useCallback((conversationId: string) => {
    activeIdRef.current = conversationId;
    setActiveId(conversationId);
    setMessages(messagesCacheRef.current.get(conversationId) ?? []);
  }, []);

  const activeChat = chats.find((chat) => chat.conversation.id === activeId) ?? null;
  const activePersonId = activeChat?.person.id;
  const activePersonHidden = activeChat?.person.hide_online_status ?? false;
  const currentUserId = profile?.id;
  const currentUserHidesOnline = profile?.hide_online_status;
  const filteredChats = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return chats.filter((chat) => !query || chat.person.display_name.toLowerCase().includes(query) || chat.person.username.toLowerCase().includes(query));
  }, [chats, filter]);

  const updateConversationPreview = useCallback((message: Message) => {
    setChats((current) => {
      let foundConversation = false;
      const updated = current.map((chat) => {
        if (chat.conversation.id !== message.conversation_id) return chat;
        foundConversation = true;
        const previous = chat.lastMessage;
        const isDuplicate = previous?.id === message.id
          || (message.client_id !== null && previous?.client_id === message.client_id);
        if (previous && !isDuplicate && new Date(previous.created_at) > new Date(message.created_at)) return chat;
        const isVisibleActiveChat = activeIdRef.current === message.conversation_id
          && document.visibilityState === "visible"
          && (!window.matchMedia("(max-width: 700px)").matches || mobileChatOpenRef.current);
        return {
          ...chat,
          lastMessage: message,
          unread: !isDuplicate && message.sender_id !== currentUserId && !isVisibleActiveChat
            ? chat.unread + 1
            : chat.unread,
        };
      });
      if (!foundConversation) return current;
      return updated.sort((a, b) => new Date(b.lastMessage?.created_at ?? b.conversation.created_at).getTime() - new Date(a.lastMessage?.created_at ?? a.conversation.created_at).getTime());
    });
  }, [currentUserId]);

  const scheduleRealtimeReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) return;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      setRealtimeRetry((current) => current + 1);
    }, 1500);
  }, []);

  useEffect(() => () => {
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
  }, []);

  const upsertMessage = useCallback((message: MessageView) => {
    const cached = messagesCacheRef.current.get(message.conversation_id) ?? [];
    messagesCacheRef.current.set(message.conversation_id, upsertMessageList(cached, message));
    if (activeIdRef.current === message.conversation_id) {
      setMessages((current) => upsertMessageList(current, message));
    }
  }, []);

  const patchMessage = useCallback((
    conversationId: string,
    messageId: string,
    patch: Partial<MessageView> | ((message: MessageView) => Partial<MessageView>),
  ) => {
    const patchList = (current: MessageView[]) => current.map((message) =>
      message.id === messageId
        ? { ...message, ...(typeof patch === "function" ? patch(message) : patch) }
        : message,
    );
    messagesCacheRef.current.set(conversationId, patchList(messagesCacheRef.current.get(conversationId) ?? []));
    if (activeIdRef.current === conversationId) setMessages(patchList);
  }, []);

  const loadMessages = useCallback(async (conversationId: string) => {
    if (!supabase) return;
    const { data: rows, error: messageError } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (messageError) throw messageError;
    const messageRows = (rows ?? []).reverse();
    const ids = messageRows.map((message) => message.id);
    const [mediaRows, reactionResult, receiptResult] = await Promise.all([
      Promise.all(messageRows.map(async (message) => {
        if (!message.media_path) return [message.id, null] as const;
        const { data, error: signedUrlError } = await supabase.storage.from("chat-media").createSignedUrl(message.media_path, 60 * 15);
        if (signedUrlError) throw signedUrlError;
        return [message.id, data?.signedUrl ?? null] as const;
      })),
      ids.length
        ? supabase.from("message_reactions").select("message_id,user_id,emoji").in("message_id", ids)
        : Promise.resolve({ data: [], error: null }),
      ids.length
        ? supabase.from("message_receipts").select("message_id,user_id,read_at").in("message_id", ids)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (reactionResult.error) throw reactionResult.error;
    if (receiptResult.error) throw receiptResult.error;
    const mediaUrls = new Map(mediaRows);
    const ownMessageIds = new Set(messageRows.filter((message) => message.sender_id === profile?.id).map((message) => message.id));
    const loaded: MessageView[] = messageRows.map((message) => ({
      ...message,
      mediaUrl: mediaUrls.get(message.id) ?? null,
      reactions: (reactionResult.data ?? []).filter((reaction) => reaction.message_id === message.id),
      read: (receiptResult.data ?? []).some((receipt) => receipt.user_id !== profile?.id && ownMessageIds.has(message.id) && Boolean(receipt.read_at)),
      status: "sent",
    }));
    const cached = messagesCacheRef.current.get(conversationId) ?? [];
    let merged = [...loaded];
    const oldestLoadedAt = loaded[0]?.created_at;
    for (const existing of cached) {
      if (existing.status === "sending" || existing.status === "failed"
        || (oldestLoadedAt && existing.created_at >= oldestLoadedAt)) {
        merged = upsertMessageList(merged, existing);
      }
    }
    const pendingMessages = merged.filter((message) => message.status === "sending" || message.status === "failed");
    const recentMessages = merged.filter((message) => message.status !== "sending" && message.status !== "failed").slice(-50);
    const synced = sortMessages([...recentMessages, ...pendingMessages]);
    messagesCacheRef.current.set(conversationId, synced);
    if (activeIdRef.current === conversationId) setMessages(synced);
  }, [profile?.id, supabase]);

  const refreshMessages = useCallback(async (conversationId: string) => {
    try {
      await loadMessages(conversationId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load messages.");
    }
  }, [loadMessages]);

  const isChatVisible = useCallback(() => (
    document.visibilityState === "visible"
    && (!window.matchMedia("(max-width: 700px)").matches || mobileChatOpenRef.current)
  ), []);

  const markConversationRead = useCallback(async (conversationId: string) => {
    if (!supabase) return;
    const { error: readError } = await supabase.rpc("mark_conversation_read", { p_conversation_id: conversationId });
    if (readError) {
      setError(readError.message);
      return;
    }
    const lastReadAt = new Date().toISOString();
    setChats((current) => current.map((chat) =>
      chat.conversation.id === conversationId ? { ...chat, unread: 0, lastReadAt } : chat,
    ));
  }, [supabase]);

  const loadDashboard = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      setError("Supabase isn’t configured. Add the values in .env.local to connect your account.");
      return;
    }

    setError("");
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      router.replace("/");
      return;
    }
    const userId = authData.user.id;

    const [
      ownProfileResult,
      sentContactsResult,
      receivedContactsResult,
      membershipsResult,
      ownBlocksResult,
      blockedByResult,
    ] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", userId).single(),
      supabase.from("contacts").select("*").eq("user_id", userId),
      supabase.from("contacts").select("*").eq("contact_id", userId),
      supabase.from("conversation_members").select("*").eq("user_id", userId),
      supabase.from("blocks").select("blocked_id").eq("blocker_id", userId),
      supabase.from("blocks").select("blocker_id").eq("blocked_id", userId),
    ]);

    const firstError = ownProfileResult.error ?? sentContactsResult.error ?? receivedContactsResult.error ?? membershipsResult.error ?? ownBlocksResult.error ?? blockedByResult.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }

    const ownProfile = ownProfileResult.data;
    setProfile(ownProfile);
    const relationships = [...(sentContactsResult.data ?? []), ...(receivedContactsResult.data ?? [])];
    const acceptedContacts = relationships.filter((contact) => contact.status === "accepted");
    const incoming = relationships.filter((contact) => contact.status === "pending" && contact.contact_id === userId);
    const sentPending = relationships.filter((contact) => contact.status === "pending" && contact.user_id === userId);
    const memberRows = membershipsResult.data ?? [];
    const conversationIds = memberRows.map((member) => member.conversation_id);
    const blockedIds = new Set([
      ...(ownBlocksResult.data ?? []).map((block) => block.blocked_id),
      ...(blockedByResult.data ?? []).map((block) => block.blocker_id),
    ]);

    const conversationResult = conversationIds.length
      ? await Promise.all([
          supabase.from("conversations").select("*").in("id", conversationIds),
          supabase.from("conversation_members").select("*").in("conversation_id", conversationIds),
          supabase.from("messages").select("*").in("conversation_id", conversationIds).order("created_at", { ascending: false }).limit(300),
          supabase.from("streaks").select("*").in("conversation_id", conversationIds),
        ])
      : null;
    if (conversationResult?.some((result) => result.error)) {
      setError(conversationResult.find((result) => result.error)?.error?.message ?? "Could not load your chats.");
      setLoading(false);
      return;
    }

    const conversationRows = conversationResult?.[0].data ?? [];
    const allMembers = conversationResult?.[1].data ?? [];
    const recentMessages = conversationResult?.[2].data ?? [];
    const streakRows = conversationResult?.[3].data ?? [];
    const otherIds = new Set<string>();
    for (const member of allMembers) {
      if (member.user_id !== userId && !blockedIds.has(member.user_id)) otherIds.add(member.user_id);
    }
    for (const contact of acceptedContacts) otherIds.add(contact.user_id === userId ? contact.contact_id : contact.user_id);
    for (const contact of incoming) otherIds.add(contact.user_id);
    for (const contact of sentPending) otherIds.add(contact.contact_id);

    const profilesResult = otherIds.size
      ? await supabase.from("profiles").select("*").in("id", [...otherIds])
      : { data: [], error: null };
    if (profilesResult.error) {
      setError(profilesResult.error.message);
      setLoading(false);
      return;
    }
    const profilesById = new Map((profilesResult.data ?? []).map((person) => [person.id, person]));
    const streakByConversation = new Map((streakRows ?? []).map((streak) => [streak.conversation_id, streak]));
    const chatsLoaded: ChatView[] = (conversationRows ?? []).flatMap((conversation) => {
      const otherMember = allMembers.find((member) => member.conversation_id === conversation.id && member.user_id !== userId);
      if (!otherMember || blockedIds.has(otherMember.user_id)) return [];
      const person = profilesById.get(otherMember.user_id);
      if (!person) return [];
      const ownMembership = memberRows.find((member) => member.conversation_id === conversation.id);
      const conversationMessages = recentMessages.filter((message) => message.conversation_id === conversation.id);
      const lastMessage = conversationMessages[0] ?? null;
      const unread = conversationMessages.filter((message) =>
        message.sender_id !== userId && ownMembership?.last_read_at && new Date(message.created_at) > new Date(ownMembership.last_read_at),
      ).length;
      return [{
        conversation,
        person,
        lastMessage,
        streak: streakByConversation.get(conversation.id) ?? null,
        unread,
        lastReadAt: ownMembership?.last_read_at ?? new Date(0).toISOString(),
      }];
    });
    chatsLoaded.sort((a, b) => new Date(b.lastMessage?.created_at ?? b.conversation.created_at).getTime() - new Date(a.lastMessage?.created_at ?? a.conversation.created_at).getTime());
    setChats(chatsLoaded);

    const pendingRows = incoming.filter((contact) => !blockedIds.has(contact.user_id));
    setPending(pendingRows.flatMap((contact) => {
      const person = profilesById.get(contact.user_id);
      return person ? [{ contact, person }] : [];
    }));
    const outgoingRows = sentPending.filter((contact) => !blockedIds.has(contact.contact_id));
    setOutgoing(outgoingRows.flatMap((contact) => {
      const person = profilesById.get(contact.contact_id);
      return person ? [{ contact, person }] : [];
    }));

    const selectedConversationId = activeIdRef.current;
    if (chatsLoaded.length && !selectedConversationId) {
      selectConversation(chatsLoaded[0].conversation.id);
    } else if (selectedConversationId && !chatsLoaded.some((chat) => chat.conversation.id === selectedConversationId)) {
      selectConversation("");
    }
    setLoading(false);
  }, [router, selectConversation, supabase]);

  const loadDashboardRef = useRef(loadDashboard);
  useEffect(() => {
    loadDashboardRef.current = loadDashboard;
  }, [loadDashboard]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const recoverRealtime = useCallback((message: string) => {
    setError(message);
    void loadDashboardRef.current();
    if (activeIdRef.current) void refreshMessages(activeIdRef.current);
    scheduleRealtimeReconnect();
  }, [refreshMessages, scheduleRealtimeReconnect]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (!supabase || !currentUserId) return;

    const reloadDashboard = () => {
      void loadDashboardRef.current();
    };
    const applyRealtimeMessage = (row: unknown) => {
      if (!isMessage(row)) {
        setError("Received an invalid realtime message event.");
        return;
      }
      const message = row;
      upsertMessage({ ...message, mediaUrl: null, reactions: [], read: false, status: "sent" });
      updateConversationPreview(message);
      if (message.sender_id !== currentUserId && activeIdRef.current === message.conversation_id
        && document.visibilityState === "visible"
        && (!window.matchMedia("(max-width: 700px)").matches || mobileChatOpenRef.current)) {
        void markConversationRead(message.conversation_id);
      }
    };
    const channel = supabase
      .channel(`ziza:account:${currentUserId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, reloadDashboard)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "conversation_members", filter: `user_id=eq.${currentUserId}` }, reloadDashboard)
      .on("postgres_changes", { event: "*", schema: "public", table: "contacts", filter: `user_id=eq.${currentUserId}` }, reloadDashboard)
      .on("postgres_changes", { event: "*", schema: "public", table: "contacts", filter: `contact_id=eq.${currentUserId}` }, reloadDashboard)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, ({ new: row }) => {
        applyRealtimeMessage(row);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, ({ new: row }) => {
        applyRealtimeMessage(row);
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, ({ old: row }) => {
        if (!isMessage(row)) {
          setError("Received an invalid realtime message event.");
          return;
        }
        const remaining = (messagesCacheRef.current.get(row.conversation_id) ?? [])
          .filter((message) => message.id !== row.id);
        messagesCacheRef.current.set(row.conversation_id, remaining);
        if (activeIdRef.current === row.conversation_id) setMessages(remaining);
      })
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          recoverRealtime("Live chat updates are unavailable. Check your Supabase Realtime configuration.");
        }
      });
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") reloadDashboard();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      void supabase.removeChannel(channel);
    };
  }, [currentUserId, markConversationRead, realtimeRetry, recoverRealtime, supabase, updateConversationPreview, upsertMessage]);

  useEffect(() => {
    if (!activeId || !currentUserId || currentUserHidesOnline === undefined || !supabase) {
      setMessages([]);
      return;
    }
    void refreshMessages(activeId);
    if (isChatVisible()) void markConversationRead(activeId);

    const channel = supabase
      .channel(`ziza:conversation:${activeId}`, { config: { private: true, presence: { key: currentUserId } } })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const senderId = typeof payload?.user_id === "string" ? payload.user_id : "";
        if (senderId !== currentUserId) setTyping(Boolean(payload?.is_typing));
      })
      .on("presence", { event: "sync" }, () => {
        const entries = Object.values(channel.presenceState()).flat() as Array<{ user_id?: string }>;
        setOnline(Boolean(activePersonId && !activePersonHidden && entries.some((entry) => entry.user_id === activePersonId)));
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED" && !currentUserHidesOnline) {
          void channel.track({ user_id: currentUserId, online_at: new Date().toISOString() });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          recoverRealtime("Live conversation updates are unavailable. Check your Supabase Realtime configuration.");
        }
      });
    channelRef.current = channel;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      void refreshMessages(activeId);
      if (isChatVisible()) void markConversationRead(activeId);
      scheduleRealtimeReconnect();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      void supabase.removeChannel(channel);
      if (channelRef.current === channel) channelRef.current = null;
      setTyping(false);
      setOnline(false);
    };
  }, [activeId, activePersonId, activePersonHidden, currentUserHidesOnline, currentUserId, isChatVisible, markConversationRead, realtimeRetry, recoverRealtime, refreshMessages, scheduleRealtimeReconnect, supabase]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, activeId]);

  async function handleSignOut() {
    if (!supabase) return;
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) setError(signOutError.message);
    else router.replace("/");
  }

  async function openContact(personId: string) {
    if (!supabase) return;
    const currentChat = chats.find((chat) => chat.person.id === personId);
    if (currentChat) {
      selectConversation(currentChat.conversation.id);
      mobileChatOpenRef.current = true;
      setMobileChatOpen(true);
      return;
    }
    const { data, error: conversationError } = await supabase.rpc("create_direct_conversation", { p_contact_id: personId });
    if (conversationError) {
      setError(conversationError.message);
      return;
    }
    await loadDashboard();
    selectConversation(data);
    mobileChatOpenRef.current = true;
    setMobileChatOpen(true);
  }

  async function respondToRequest(contact: Contact, accept: boolean) {
    if (!supabase) return;
    const { error: responseError } = await supabase.rpc("respond_to_contact_request", { p_request_id: contact.id, p_accept: accept });
    if (responseError) {
      setError(responseError.message);
      return;
    }
    await loadDashboard();
    if (accept) await openContact(contact.user_id);
  }

  async function persistMessage(message: MessageView) {
    if (!supabase || !message.client_id || pendingSendsRef.current.has(message.client_id)) return;
    pendingSendsRef.current.add(message.client_id);
    upsertMessage({ ...message, status: "sending" });
    try {
      const { data, error: insertError } = await supabase.from("messages").insert({
        client_id: message.client_id,
        conversation_id: message.conversation_id,
        sender_id: message.sender_id,
        reply_to_id: message.reply_to_id,
        type: message.type,
        body: message.body,
        media_path: message.media_path,
      }).select("*").single();
      let savedMessage = data;
      if (insertError) {
        const { data: existingMessage, error: lookupError } = await supabase
          .from("messages")
          .select("*")
          .eq("sender_id", message.sender_id)
          .eq("client_id", message.client_id)
          .maybeSingle();
        if (lookupError) {
          upsertMessage({ ...message, status: "failed" });
          setError(`${insertError.message} Also, checking whether the message was saved failed: ${lookupError.message}`);
          return;
        }
        if (!existingMessage) {
          upsertMessage({ ...message, status: "failed" });
          setError(insertError.message);
          return;
        }
        savedMessage = existingMessage;
      }
      if (!savedMessage) {
        upsertMessage({ ...message, status: "failed" });
        setError("The message insert returned no row.");
        return;
      }
      const confirmed: MessageView = {
        ...savedMessage,
        mediaUrl: null,
        reactions: [],
        read: false,
        status: "sent",
      };
      upsertMessage(confirmed);
      updateConversationPreview(confirmed);
      if (confirmed.media_path) {
        try {
          const { data: signedUrl, error: signedUrlError } = await supabase.storage
            .from("chat-media")
            .createSignedUrl(confirmed.media_path, 60 * 15);
          if (signedUrlError) {
            setError(signedUrlError.message);
          } else if (signedUrl) {
            upsertMessage({ ...confirmed, mediaUrl: signedUrl.signedUrl });
          }
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Could not load the attachment.");
        }
      }
    } catch (caught) {
      upsertMessage({ ...message, status: "failed" });
      setError(caught instanceof Error ? caught.message : "Could not send the message.");
    } finally {
      pendingSendsRef.current.delete(message.client_id);
    }
  }

  async function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!supabase || !profile || !activeChat || !draft.trim()) return;
    const body = draft.trim();
    const replyToId = reply?.id ?? null;
    const clientId = crypto.randomUUID();
    const optimistic: MessageView = {
      id: clientId,
      client_id: clientId,
      conversation_id: activeChat.conversation.id,
      sender_id: profile.id,
      reply_to_id: replyToId,
      type: "text",
      body,
      media_path: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      expires_at: null,
      mediaUrl: null,
      reactions: [],
      read: false,
      status: "sending",
    };
    setDraft("");
    setReply(null);
    setError("");
    upsertMessage(optimistic);
    updateConversationPreview(optimistic);
    void persistMessage(optimistic);
  }

  function retryMessage(message: MessageView) {
    setError("");
    void persistMessage(message);
  }

  async function sendFile(file: File, type: "image" | "document" | "voice") {
    if (!supabase || !profile || !activeChat) return;
    setSending(true);
    setError("");
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-90) || "attachment";
    const path = `${activeChat.conversation.id}/${profile.id}/${crypto.randomUUID()}-${safeName}`;
    const { error: uploadError } = await supabase.storage.from("chat-media").upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
    if (uploadError) {
      setSending(false);
      setError(uploadError.message);
      return;
    }
    const clientId = crypto.randomUUID();
    const optimistic: MessageView = {
      id: clientId,
      client_id: clientId,
      conversation_id: activeChat.conversation.id,
      sender_id: profile.id,
      reply_to_id: null,
      type,
      body: null,
      media_path: path,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      expires_at: null,
      mediaUrl: null,
      reactions: [],
      read: false,
      status: "sending",
    };
    upsertMessage(optimistic);
    updateConversationPreview(optimistic);
    await persistMessage(optimistic);
    setSending(false);
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const type = file.type.startsWith("image/") ? "image" : "document";
    if (type === "document" && file.size > 25 * 1024 * 1024) {
      setError("Files must be 25 MB or smaller.");
      return;
    }
    if (type === "image" && file.size > 25 * 1024 * 1024) {
      setError("Images must be 25 MB or smaller.");
      return;
    }
    await sendFile(file, type);
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined);
      recordingChunks.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) recordingChunks.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recordingChunks.current, { type: recorder.mimeType || "audio/webm" });
        stream.getTracks().forEach((track) => track.stop());
        if (recordTimer.current !== null) window.clearInterval(recordTimer.current);
        recordTimer.current = null;
        if (blob.size) void sendFile(new File([blob], `voice-${Date.now()}.webm`, { type: blob.type }), "voice");
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecordSeconds(0);
      setRecording(true);
      recordTimer.current = window.setInterval(() => setRecordSeconds((seconds) => {
        if (seconds >= 179) {
          recorder.stop();
          setRecording(false);
          return 180;
        }
        return seconds + 1;
      }), 1000);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Microphone permission was denied.");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setRecording(false);
  }

  function updateTyping(value: string) {
    setDraft(value);
    if (!channelRef.current || !profile) return;
    void channelRef.current.send({ type: "broadcast", event: "typing", payload: { user_id: profile.id, is_typing: true } });
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      void channelRef.current?.send({ type: "broadcast", event: "typing", payload: { user_id: profile.id, is_typing: false } });
    }, 1400);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function toggleReaction(message: MessageView, emoji: string) {
    if (!supabase || !profile) return;
    const existing = message.reactions.find((reaction) => reaction.emoji === emoji && reaction.user_id === profile.id);
    const result = existing
      ? await supabase.from("message_reactions").delete().eq("message_id", message.id).eq("user_id", profile.id).eq("emoji", emoji)
      : await supabase.from("message_reactions").insert({ message_id: message.id, user_id: profile.id, emoji });
    if (result.error) setError(result.error.message);
    else if (activeId) {
      patchMessage(activeId, message.id, (current) => ({
        reactions: existing
          ? current.reactions.filter((reaction) => reaction.emoji !== emoji || reaction.user_id !== profile.id)
          : [...current.reactions, { emoji, user_id: profile.id }],
      }));
    }
  }

  async function saveEdit(messageId: string) {
    if (!supabase || !editDraft.trim()) return;
    const body = editDraft.trim();
    const { error: editError } = await supabase.from("messages").update({ body }).eq("id", messageId);
    if (editError) setError(editError.message);
    else {
      setEditingId("");
      if (activeId) patchMessage(activeId, messageId, { body, edited_at: new Date().toISOString() });
    }
  }

  async function deleteMessage(messageId: string) {
    if (!supabase || !window.confirm("Delete this message for everyone?")) return;
    const { error: deleteError } = await supabase.from("messages").update({ deleted_at: new Date().toISOString() }).eq("id", messageId);
    if (deleteError) setError(deleteError.message);
    else if (activeId) patchMessage(activeId, messageId, { deleted_at: new Date().toISOString() });
  }

  async function blockActivePerson() {
    if (!supabase || !activeChat || !window.confirm(`Block ${activeChat.person.display_name}? They won’t be able to contact you or see your stories.`)) return;
    const { error: blockError } = await supabase.rpc("block_user", { p_user_id: activeChat.person.id });
    if (blockError) setError(blockError.message);
    else {
      selectConversation("");
      mobileChatOpenRef.current = false;
      setMobileChatOpen(false);
      await loadDashboard();
    }
  }

  const [copied, setCopied] = useState(false);
  async function copyMyNumber() {
    if (!profile) return;
    await navigator.clipboard.writeText(formatZizaNumber(profile.ziza_number));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <main className={`app-shell ${mobileChatOpen ? "mobile-chat-open" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="sidebar-top">
            <a className="small-brand" href="/chat"><span className="brand-mark"><MessageCircle size={19} /></span><span>Ziza<span className="brand-dot">.</span></span></a>
            <div className="head-actions">
              <button className="icon-button" title="Stories" onClick={() => router.push("/stories")}><Sparkles size={17} /></button>
              <button className="icon-button" title="Settings" onClick={() => router.push("/settings")}><Settings2 size={17} /></button>
              <button className="icon-button" title="Sign out" onClick={() => void handleSignOut()}><LogOut size={16} /></button>
            </div>
          </div>
          {profile && (
            <div className="own-profile">
              <Avatar name={profile.display_name} url={profile.avatar_url} className="avatar-sm" />
              <div className="own-details"><strong>{profile.display_name}</strong><span>{formatZizaNumber(profile.ziza_number)}</span></div>
              <button className="copy-mini" title={copied ? "Copied" : "Copy Ziza Number"} onClick={() => void copyMyNumber()}>{copied ? <Check size={14} /> : <CopyIcon />}</button>
            </div>
          )}
        </div>

        <div className="story-strip">
          <button className="story-chip" onClick={() => router.push("/stories")}>
            <span className="story-ring mine"><Plus size={19} /><i className="story-add"><Plus size={10} /></i></span>
            <span>Your story</span>
          </button>
          {chats.slice(0, 7).map((chat) => (
            <button key={chat.person.id} className="story-chip" title={`Stories from ${chat.person.display_name}`} onClick={() => router.push("/stories")}>
              <span className="story-ring"><Avatar name={chat.person.display_name} url={chat.person.avatar_url} /></span>
              <span>{chat.person.display_name.split(" ")[0]}</span>
            </button>
          ))}
        </div>

        <div className="search-row">
          <label className="search-box"><Search size={15} /><input placeholder="Search conversations" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
          <button className="add-contact-button" title="Find someone by Ziza Number" onClick={() => setSearchOpen(true)}><Plus size={18} /></button>
        </div>
        <div className="list-tabs">
          <button className={listMode === "chats" ? "active" : ""} onClick={() => setListMode("chats")}>Messages <span>{chats.length || ""}</span></button>
          <button className={listMode === "requests" ? "active" : ""} onClick={() => setListMode("requests")}>Requests {pending.length > 0 && <span className="unread-badge">{pending.length}</span>}</button>
        </div>

        <div className="chat-list">
          {listMode === "chats" ? (
            <>
              <div className="list-label">YOUR CONVERSATIONS</div>
              {loading ? <div className="loading-screen"><span><span className="button-spinner" /> Loading your chats</span></div> : filteredChats.length ? filteredChats.map((chat) => {
                const streak = streakState(chat.streak);
                return (
                  <button className={`chat-row ${activeId === chat.conversation.id ? "active" : ""}`} key={chat.conversation.id} onClick={() => { selectConversation(chat.conversation.id); mobileChatOpenRef.current = true; setMobileChatOpen(true); }}>
                    <Avatar name={chat.person.display_name} url={chat.person.avatar_url} />
                    <span className="chat-row-main">
                      <span className="chat-row-line"><strong>{chat.person.display_name}</strong><time>{chat.lastMessage ? timeLabel(chat.lastMessage.created_at) : timeLabel(chat.conversation.created_at)}</time></span>
                      <span className="chat-preview">
                        <span>{chat.lastMessage?.deleted_at ? "Message deleted" : chat.lastMessage?.body ?? (chat.lastMessage?.type === "voice" ? "🎙 Voice note" : chat.lastMessage?.type === "image" ? "📷 Photo" : chat.lastMessage?.type === "document" ? "📎 Attachment" : "Say hello")}</span>
                        <span className="preview-icons">
                          {streak.count > 0 && <span className={`streak-badge ${streak.warning ? "warning" : ""}`} title={streak.warning ? "Streak expires soon" : "Active streak"}><Flame size={12} />{streak.count}{streak.warning && <Clock3 size={10} />}</span>}
                          {chat.unread > 0 && <span className="unread-badge">{chat.unread > 99 ? "99+" : chat.unread}</span>}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              }) : <div className="sidebar-empty">{filter ? "No chats match that search." : "No conversations yet. Find a friend by their Ziza Number."}</div>}
            </>
          ) : (
            <>
              <div className="list-label">INCOMING REQUESTS</div>
              {pending.map(({ contact, person }) => (
                <div className="request-row" key={contact.id}>
                  <Avatar name={person.display_name} url={person.avatar_url} />
                  <div className="request-copy"><strong>{person.display_name}</strong><span>@{person.username}</span></div>
                  <button className="request-accept" aria-label={`Accept ${person.display_name}'s request`} title="Accept request" onClick={() => void respondToRequest(contact, true)}><Check size={15} /></button>
                  <button className="request-decline" aria-label={`Decline ${person.display_name}'s request`} title="Decline request" onClick={() => void respondToRequest(contact, false)}><X size={15} /></button>
                </div>
              ))}
              <div className="list-label">SENT REQUESTS</div>
              {outgoing.map(({ contact, person }) => (
                <div className="request-row" key={contact.id}>
                  <Avatar name={person.display_name} url={person.avatar_url} />
                  <div className="request-copy"><strong>{person.display_name}</strong><span>@{person.username}</span></div>
                  <span className="request-pending">Pending</span>
                </div>
              ))}
              {!pending.length && !outgoing.length && <div className="sidebar-empty">No new requests. Your contacts are always in your control.</div>}
            </>
          )}
        </div>
        <div className="sidebar-footer"><span className="connection-state"><i className={`connection-dot ${profile ? "online" : ""}`} /> Private connection</span><span>v1.0</span></div>
      </aside>

      <section className="chat-main">
        {error && <div className="inline-error" role="alert">{error}<button className="copy-mini" onClick={() => setError("")}><X size={13} /></button></div>}
        {!activeChat ? (
          <div className="chat-empty">
            <div className="empty-content">
              <div className="empty-logo"><MessageCircle size={34} /></div>
              <h2>Your conversations, your way.</h2>
              <p>Find your people using their private Ziza Number. No public directory, no noise—just meaningful connection.</p>
              <button className="primary-button" onClick={() => setSearchOpen(true)}>Find a friend <ArrowRight size={15} /></button>
            </div>
          </div>
        ) : (
          <>
            <header className="chat-topbar">
              <button className="icon-button back-to-list" aria-label="Back to chats" onClick={() => { mobileChatOpenRef.current = false; setMobileChatOpen(false); }}><ArrowLeft size={18} /></button>
              <div className="chat-person">
                <Avatar name={activeChat.person.display_name} url={activeChat.person.avatar_url} />
                <div className="chat-person-copy"><strong>{activeChat.person.display_name}</strong><span>{typing ? <><i className="online-dot" /> Typing…</> : activeChat.person.hide_online_status ? "Status hidden" : online ? <><i className="online-dot" /> Online</> : "Offline"} <span className="number-separator">·</span> {formatZizaNumber(activeChat.person.ziza_number)}</span></div>
              </div>
              <div className="chat-top-actions">
                {streakState(activeChat.streak).count > 0 && <div className="chat-streak-pill"><Flame size={15} /><b>{streakState(activeChat.streak).count}</b><span>{streakState(activeChat.streak).warning ? "Expires soon" : "day streak"}</span></div>}
                <button className="icon-button" title="Disappearing messages" onClick={() => router.push("/settings")}><Clock3 size={17} /></button>
                <button className="icon-button" title="Block contact" onClick={() => void blockActivePerson()}><ShieldBan size={17} /></button>
                <button className="icon-button" title="More options" onClick={() => router.push("/settings")}><MoreHorizontal size={18} /></button>
              </div>
            </header>

            <div className="chat-feed" ref={feedRef}>
              {messages.length === 0 ? <div className="feed-empty"><div className="empty-logo"><MessageCircle size={28} /></div><strong>Start your conversation</strong><span>Send a message to {activeChat.person.display_name}.</span></div> : messages.map((message, index) => {
                const isOwn = message.sender_id === profile?.id;
                const replyMessage = messages.find((candidate) => candidate.id === message.reply_to_id);
                const previous = messages[index - 1];
                const showDate = !previous || new Date(previous.created_at).toDateString() !== new Date(message.created_at).toDateString();
                return (
                  <div key={message.client_id ? `${message.sender_id}:${message.client_id}` : message.id} className={`message-line ${isOwn ? "own" : "other"}`}>
                    {!isOwn && <Avatar name={activeChat.person.display_name} url={activeChat.person.avatar_url} />}
                    <div className="message-content">
                      {showDate && <div className="feed-date">{new Date(message.created_at).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>}
                      {editingId === message.id ? (
                        <form className="edit-message-form" onSubmit={(event) => { event.preventDefault(); void saveEdit(message.id); }}>
                          <input value={editDraft} onChange={(event) => setEditDraft(event.target.value)} autoFocus />
                          <button type="submit" className="icon-button" title="Save edit"><Check size={14} /></button>
                          <button type="button" className="icon-button" title="Cancel edit" onClick={() => setEditingId("")}><X size={14} /></button>
                        </form>
                      ) : (
                        <>
                          <div className={`message-bubble ${message.deleted_at ? "deleted" : ""}`}>
                            {replyMessage && !message.deleted_at && <div className="reply-quote"><b>{replyMessage.sender_id === profile?.id ? "You" : activeChat.person.display_name}</b>{replyMessage.deleted_at ? "Message deleted" : replyMessage.body ?? "Attachment"}</div>}
                            {message.deleted_at ? <p className="message-body">This message was deleted</p> : message.type === "image" && message.mediaUrl ? <a href={message.mediaUrl} target="_blank" rel="noreferrer"><img className="message-image" src={message.mediaUrl} alt="Shared image" /></a> : message.type === "voice" && message.mediaUrl ? <audio className="message-audio" controls src={message.mediaUrl} /> : message.type === "document" && message.mediaUrl ? <a className="message-file" href={message.mediaUrl} target="_blank" rel="noreferrer" download><FileText size={17} /> Download attachment <ArrowDown size={13} /></a> : <p className="message-body">{message.body}</p>}
                            <div className="message-meta">{message.edited_at && !message.deleted_at && <span className="edited-label">edited</span>}{isOwn && message.status === "sending" && <span>Sending…</span>}<time>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{isOwn && message.status !== "failed" && <span className="message-ticks">{message.read ? <CheckCheck size={12} /> : <Check size={12} />}</span>}</div>
                          </div>
                          {isOwn && message.status === "failed" && <button className="message-retry" type="button" onClick={() => retryMessage(message)}>Failed to send · Retry</button>}
                          {message.reactions.length > 0 && <div className="reaction-row">{Array.from(new Set(message.reactions.map((reaction) => reaction.emoji))).map((emoji) => <button className="reaction-chip" key={emoji} onClick={() => void toggleReaction(message, emoji)}>{emoji} {message.reactions.filter((reaction) => reaction.emoji === emoji).length}</button>)}</div>}
                        </>
                      )}
                    </div>
                    {!message.deleted_at && message.status !== "sending" && message.status !== "failed" && <div className="message-actions">
                      <button title="Reply" onClick={() => setReply(message)}><MessageCircle size={13} /></button>
                      <button title="React" onClick={() => void toggleReaction(message, "💜")}><Smile size={13} /></button>
                      {isOwn && <button title="Edit message" onClick={() => { setEditingId(message.id); setEditDraft(message.body ?? ""); }}><Sticker size={13} /></button>}
                      {isOwn && <button title="Delete for everyone" onClick={() => void deleteMessage(message.id)}><X size={13} /></button>}
                    </div>}
                  </div>
                );
              })}
            </div>

            {typing && <div className="typing-note">{activeChat.person.display_name} is typing…</div>}
            <div className="composer-wrap">
              {reply && <div className="reply-banner"><span>Replying to {reply.sender_id === profile?.id ? "yourself" : activeChat.person.display_name}: {reply.deleted_at ? "Message deleted" : reply.body ?? "Attachment"}</span><button aria-label="Cancel reply" onClick={() => setReply(null)}><X size={14} /></button></div>}
              <form className="composer" onSubmit={(event) => void sendMessage(event)}>
                <div className="composer-tools">
                  <button className="composer-tool" type="button" title="Add emoji" onClick={() => setEmojiOpen((value) => !value)}><Smile size={17} /></button>
                  <button className="composer-tool" type="button" title="Attach image or file" onClick={() => fileInputRef.current?.click()}><Paperclip size={17} /></button>
                  <input ref={fileInputRef} hidden type="file" accept="image/*,.pdf,.txt,.docx" onChange={(event) => void handleFileChange(event)} />
                </div>
                <textarea value={draft} onChange={(event) => updateTyping(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder="Write a message..." rows={1} aria-label="Message" />
                {draft.trim() ? <button className="send-button" type="submit" title="Send message" disabled={sending}><Send size={16} /></button> : <button className={`composer-tool record-button ${recording ? "recording" : ""}`} type="button" title={recording ? `Stop recording (${recordSeconds}s)` : "Record voice note"} onClick={() => recording ? stopRecording() : void startRecording()}>{recording ? <Square size={15} /> : <Mic size={17} />}</button>}
              </form>
              {emojiOpen && <div className="emoji-popover"><div className="emoji-grid">{QUICK_EMOJIS.map((emoji) => <button type="button" key={emoji} onClick={() => { setDraft((value) => value + emoji); setEmojiOpen(false); }}>{emoji}</button>)}</div></div>}
              <div className="composer-caption">{recording ? `Recording voice note · ${recordSeconds}s` : "Enter to send · Shift + Enter for a new line"}<span><LockKeyhole size={10} /> Private conversation</span></div>
            </div>
          </>
        )}
      </section>

      {searchOpen && profile && <ContactSearchDialog onClose={() => setSearchOpen(false)} onContact={async (person) => { setSearchOpen(false); await openContact(person.id); }} onRequestSent={async () => { await loadDashboard(); }} />}
    </main>
  );
}

function CopyIcon() {
  return <Copy size={14} />;
}
