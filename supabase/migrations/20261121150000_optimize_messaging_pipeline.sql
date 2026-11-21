create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id, conversation_id);

create index if not exists contacts_user_status_idx
  on public.contacts (user_id, status);

create index if not exists contacts_contact_status_idx
  on public.contacts (contact_id, status);
