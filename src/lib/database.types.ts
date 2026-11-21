export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row & Record<string, unknown>;
  Insert: Insert & Record<string, unknown>;
  Update: Update & Record<string, unknown>;
  Relationships: [];
};

export interface Profile {
  id: string;
  username: string;
  ziza_number: string;
  display_name: string;
  avatar_url: string | null;
  hide_online_status: boolean;
  read_receipts_enabled: boolean;
  disappearing_messages: "off" | "24h" | "7d";
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  user_id: string;
  contact_id: string;
  status: "pending" | "accepted" | "rejected";
  requested_at: string;
  accepted_at: string | null;
}

export interface Conversation {
  id: string;
  type: "direct" | "group";
  created_by: string;
  created_at: string;
}

export interface ConversationMember {
  conversation_id: string;
  user_id: string;
  joined_at: string;
  last_read_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  reply_to_id: string | null;
  type: "text" | "image" | "document" | "voice";
  body: string | null;
  media_path: string | null;
  duration_seconds: number | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  expires_at: string | null;
}

export interface Streak {
  conversation_id: string;
  user_a: string;
  user_b: string;
  user_a_last_message_date: string | null;
  user_b_last_message_date: string | null;
  last_completed_date: string | null;
  current_count: number;
  expires_at: string | null;
}

export interface Story {
  id: string;
  user_id: string;
  type: "text" | "image";
  content: string | null;
  media_path: string | null;
  created_at: string;
  expires_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: Table<Profile>;
      contacts: Table<Contact, Pick<Contact, "user_id" | "contact_id">>;
      conversations: Table<Conversation>;
      conversation_members: Table<ConversationMember>;
      messages: Table<Message, Pick<Message, "conversation_id" | "sender_id"> & Partial<Pick<Message, "reply_to_id" | "type" | "body" | "media_path" | "duration_seconds">>>;
      message_reactions: Table<{ message_id: string; user_id: string; emoji: string; created_at: string }, Pick<{ message_id: string; user_id: string; emoji: string }, "message_id" | "user_id" | "emoji">>;
      message_receipts: Table<{ message_id: string; user_id: string; delivered_at: string | null; read_at: string | null }>;
      streaks: Table<Streak>;
      stories: Table<Story, Pick<Story, "user_id" | "type"> & Partial<Pick<Story, "content" | "media_path">>>;
      blocks: Table<{ blocker_id: string; blocked_id: string; created_at: string }, Pick<{ blocker_id: string; blocked_id: string }, "blocker_id" | "blocked_id">>;
    };
    Views: Record<string, never>;
    Functions: {
      lookup_ziza_number: {
        Args: { p_ziza_number: string };
        Returns: Array<{ user_id: string; username: string; display_name: string; ziza_number: string; avatar_url: string | null }>;
      };
      send_contact_request: { Args: { p_ziza_number: string }; Returns: string };
      respond_to_contact_request: { Args: { p_request_id: string; p_accept: boolean }; Returns: undefined };
      create_direct_conversation: { Args: { p_contact_id: string }; Returns: string };
      mark_message_read: { Args: { p_message_id: string }; Returns: boolean };
      mark_conversation_read: { Args: { p_conversation_id: string }; Returns: undefined };
      is_conversation_member: { Args: { p_conversation_id: string; p_user_id?: string }; Returns: boolean };
      block_user: { Args: { p_user_id: string }; Returns: undefined };
      unblock_user: { Args: { p_user_id: string }; Returns: undefined };
    };
    Enums: {
      contact_status: Contact["status"];
      disappearing_message_setting: Profile["disappearing_messages"];
      conversation_type: Conversation["type"];
      message_type: Message["type"];
      story_type: Story["type"];
    };
    CompositeTypes: Record<string, never>;
  };
}
