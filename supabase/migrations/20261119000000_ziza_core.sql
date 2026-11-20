create extension if not exists pgcrypto with schema extensions;

create type public.contact_status as enum ('pending', 'accepted', 'rejected');
create type public.disappearing_message_setting as enum ('off', '24h', '7d');
create type public.conversation_type as enum ('direct', 'group');
create type public.message_type as enum ('text', 'image', 'document', 'voice');
create type public.story_type as enum ('text', 'image');

create table public.ziza_number_reservations (
  ziza_number text primary key check (ziza_number ~ '^[0-9]{10}$'),
  reserved_at timestamptz not null default now()
);

alter table public.ziza_number_reservations enable row level security;
revoke all on public.ziza_number_reservations from anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,24}$'),
  ziza_number text not null unique references public.ziza_number_reservations (ziza_number),
  display_name text not null check (char_length(display_name) between 1 and 60),
  avatar_url text,
  hide_online_status boolean not null default false,
  read_receipts_enabled boolean not null default true,
  disappearing_messages public.disappearing_message_setting not null default 'off',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_username_lower_idx on public.profiles (lower(username));

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contact_id uuid not null references public.profiles (id) on delete cascade,
  status public.contact_status not null default 'pending',
  requested_at timestamptz not null default now(),
  accepted_at timestamptz,
  check (user_id <> contact_id),
  check ((status = 'accepted') = (accepted_at is not null))
);

create unique index contacts_pair_unique_idx
  on public.contacts (least(user_id, contact_id), greatest(user_id, contact_id));
create index contacts_contact_status_idx on public.contacts (contact_id, status);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  type public.conversation_type not null default 'direct',
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index conversation_members_user_idx on public.conversation_members (user_id, conversation_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id),
  reply_to_id uuid references public.messages (id) on delete set null,
  type public.message_type not null default 'text',
  body text,
  media_path text,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  expires_at timestamptz,
  check (
    deleted_at is not null
    or (type = 'text' and body is not null and media_path is null)
    or (type <> 'text' and media_path is not null)
  )
);

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);
create index messages_expiry_idx on public.messages (expires_at) where expires_at is not null;

create table public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 32),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table public.message_receipts (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  delivered_at timestamptz,
  read_at timestamptz,
  primary key (message_id, user_id)
);

create table public.streaks (
  conversation_id uuid primary key references public.conversations (id) on delete cascade,
  user_a uuid not null references public.profiles (id) on delete cascade,
  user_b uuid not null references public.profiles (id) on delete cascade,
  user_a_last_message_date date,
  user_b_last_message_date date,
  last_completed_date date,
  current_count integer not null default 0 check (current_count >= 0),
  expires_at timestamptz,
  check (user_a < user_b)
);

create table public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type public.story_type not null,
  content text,
  media_path text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  check (
    (type = 'text' and content is not null and media_path is null)
    or (type = 'image' and media_path is not null)
  ),
  check (expires_at <= created_at + interval '24 hours')
);

create index stories_active_user_idx on public.stories (user_id, expires_at desc);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function public.new_ziza_number()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bytes bytea;
  v_candidate text;
  v_inserted integer;
begin
  loop
    v_bytes := extensions.gen_random_bytes(10);
    select string_agg(chr(48 + get_byte(v_bytes, n) % 10), '' order by n)
      into v_candidate
      from generate_series(0, 9) as gs(n);

    insert into public.ziza_number_reservations (ziza_number)
    values (v_candidate)
    on conflict do nothing;

    get diagnostics v_inserted = row_count;
    if v_inserted = 1 then
      return v_candidate;
    end if;
  end loop;
end;
$$;

create function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text;
begin
  v_username := new.raw_user_meta_data ->> 'username';
  if v_username is null or v_username !~ '^[A-Za-z0-9_]{3,24}$' then
    raise exception 'A username of 3-24 letters, numbers, or underscores is required';
  end if;

  insert into public.profiles (id, username, ziza_number, display_name)
  values (
    new.id,
    v_username,
    public.new_ziza_number(),
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), v_username)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.create_profile_for_new_user();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create function public.is_conversation_member(p_conversation_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_members cm
    where cm.conversation_id = p_conversation_id
      and cm.user_id = p_user_id
  );
$$;

create function public.send_contact_request(p_ziza_number text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requester uuid := auth.uid();
  v_number text;
  v_contact uuid;
  v_request_id uuid;
begin
  if v_requester is null then
    raise exception 'Authentication required';
  end if;

  v_number := replace(p_ziza_number, '-', '');
  if v_number !~ '^[0-9]{10}$' then
    raise exception 'Enter a valid 10-digit Ziza Number';
  end if;

  select p.id into v_contact
  from public.profiles p
  where p.ziza_number = v_number;

  if v_contact is null then
    raise exception 'No account found for that Ziza Number';
  end if;
  if v_contact = v_requester then
    raise exception 'You cannot add yourself';
  end if;

  insert into public.contacts (user_id, contact_id)
  values (v_requester, v_contact)
  on conflict do nothing
  returning id into v_request_id;

  if v_request_id is null then
    raise exception 'A contact relationship or request already exists';
  end if;
  return v_request_id;
end;
$$;

create function public.lookup_ziza_number(p_ziza_number text)
returns table (
  user_id uuid,
  username text,
  display_name text,
  ziza_number text,
  avatar_url text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  v_number := replace(p_ziza_number, '-', '');
  if v_number !~ '^[0-9]{10}$' then
    raise exception 'Enter a valid 10-digit Ziza Number';
  end if;

  return query
  select p.id, p.username, p.display_name, p.ziza_number, p.avatar_url
  from public.profiles p
  where p.ziza_number = v_number
    and p.id <> auth.uid();
end;
$$;

create function public.respond_to_contact_request(p_request_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.contacts
  set status = case when p_accept then 'accepted'::public.contact_status else 'rejected'::public.contact_status end,
      accepted_at = case when p_accept then now() else null end
  where id = p_request_id
    and contact_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Contact request not found or already handled';
  end if;
end;
$$;

create function public.create_direct_conversation(p_contact_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_first uuid;
  v_second uuid;
  v_conversation_id uuid;
begin
  if v_user_id is null or p_contact_id = v_user_id then
    raise exception 'A valid signed-in contact is required';
  end if;

  if not exists (
    select 1 from public.contacts c
    where c.status = 'accepted'
      and ((c.user_id = v_user_id and c.contact_id = p_contact_id)
        or (c.user_id = p_contact_id and c.contact_id = v_user_id))
  ) then
    raise exception 'Direct conversations require an accepted contact';
  end if;

  v_first := least(v_user_id, p_contact_id);
  v_second := greatest(v_user_id, p_contact_id);
  perform pg_advisory_xact_lock(hashtextextended(v_first::text || ':' || v_second::text, 0));

  select c.id into v_conversation_id
  from public.conversations c
  join public.conversation_members a on a.conversation_id = c.id and a.user_id = v_first
  join public.conversation_members b on b.conversation_id = c.id and b.user_id = v_second
  where c.type = 'direct'
    and (select count(*) from public.conversation_members cm where cm.conversation_id = c.id) = 2
  limit 1;

  if v_conversation_id is not null then
    return v_conversation_id;
  end if;

  insert into public.conversations (type, created_by)
  values ('direct', v_user_id)
  returning id into v_conversation_id;

  insert into public.conversation_members (conversation_id, user_id)
  values (v_conversation_id, v_first), (v_conversation_id, v_second);

  return v_conversation_id;
end;
$$;

create function public.apply_message_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_setting public.disappearing_message_setting;
begin
  if new.reply_to_id is not null and not exists (
    select 1 from public.messages m
    where m.id = new.reply_to_id
      and m.conversation_id = new.conversation_id
      and m.deleted_at is null
      and (m.expires_at is null or m.expires_at > now())
  ) then
    raise exception 'Reply target is not available in this conversation';
  end if;

  if new.type <> 'text' and (
    split_part(new.media_path, '/', 1) <> new.conversation_id::text
    or split_part(new.media_path, '/', 2) <> new.sender_id::text
  ) then
    raise exception 'Media must be uploaded to the sender folder for this conversation';
  end if;

  select p.disappearing_messages into v_setting
  from public.profiles p
  where p.id = new.sender_id;

  if v_setting = '24h' then
    new.expires_at := new.created_at + interval '24 hours';
  elsif v_setting = '7d' then
    new.expires_at := new.created_at + interval '7 days';
  else
    new.expires_at := null;
  end if;

  return new;
end;
$$;

create trigger messages_apply_defaults
  before insert on public.messages
  for each row execute function public.apply_message_defaults();

create function public.protect_message_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception 'Deleted messages cannot be changed';
  end if;
  if new.body is distinct from old.body then
    new.edited_at := now();
  else
    new.edited_at := old.edited_at;
  end if;
  if new.deleted_at is distinct from old.deleted_at and new.deleted_at is not null then
    new.deleted_at := now();
    new.body := null;
    new.media_path := null;
  end if;
  return new;
end;
$$;

create trigger messages_protect_update
  before update on public.messages
  for each row execute function public.protect_message_update();

create function public.update_chat_streak()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_participants uuid[];
  v_day date := (new.created_at at time zone 'UTC')::date;
  v_streak public.streaks%rowtype;
  v_next_count integer;
begin
  if (select c.type from public.conversations c where c.id = new.conversation_id) <> 'direct' then
    return new;
  end if;

  select array_agg(cm.user_id order by cm.user_id)
    into v_participants
    from public.conversation_members cm
    where cm.conversation_id = new.conversation_id;

  if coalesce(array_length(v_participants, 1), 0) <> 2 then
    return new;
  end if;

  insert into public.streaks (conversation_id, user_a, user_b)
  values (new.conversation_id, v_participants[1], v_participants[2])
  on conflict (conversation_id) do nothing;

  select * into v_streak
  from public.streaks
  where conversation_id = new.conversation_id
  for update;

  if new.sender_id = v_streak.user_a then
    v_streak.user_a_last_message_date := v_day;
  elsif new.sender_id = v_streak.user_b then
    v_streak.user_b_last_message_date := v_day;
  else
    return new;
  end if;

  if v_streak.user_a_last_message_date = v_day
    and v_streak.user_b_last_message_date = v_day
    and v_streak.last_completed_date is distinct from v_day then
    if v_streak.last_completed_date = v_day - 1 then
      v_next_count := v_streak.current_count + 1;
    else
      v_next_count := 1;
    end if;
    v_streak.last_completed_date := v_day;
    v_streak.current_count := v_next_count;
    v_streak.expires_at := (v_day + 1)::timestamp at time zone 'UTC';
  end if;

  update public.streaks
  set user_a_last_message_date = v_streak.user_a_last_message_date,
      user_b_last_message_date = v_streak.user_b_last_message_date,
      last_completed_date = v_streak.last_completed_date,
      current_count = v_streak.current_count,
      expires_at = v_streak.expires_at
  where conversation_id = new.conversation_id;

  return new;
end;
$$;

create trigger messages_update_streak
  after insert on public.messages
  for each row execute function public.update_chat_streak();

create function public.set_story_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.type = 'image' and split_part(new.media_path, '/', 1) <> new.user_id::text then
    raise exception 'Story media must be uploaded to the owner''s folder';
  end if;
  new.expires_at := new.created_at + interval '24 hours';
  return new;
end;
$$;

create trigger stories_set_expiry
  before insert on public.stories
  for each row execute function public.set_story_expiry();

create function public.mark_message_read(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_receipts_enabled boolean;
  v_conversation_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select p.read_receipts_enabled into v_receipts_enabled
  from public.profiles p where p.id = v_user_id;
  if not coalesce(v_receipts_enabled, false) then
    return false;
  end if;

  select m.conversation_id into v_conversation_id
  from public.messages m
  where m.id = p_message_id and m.sender_id <> v_user_id;

  if v_conversation_id is null or not public.is_conversation_member(v_conversation_id, v_user_id) then
    raise exception 'Message not found or unavailable';
  end if;

  insert into public.message_receipts (message_id, user_id, delivered_at, read_at)
  values (p_message_id, v_user_id, now(), now())
  on conflict (message_id, user_id) do update
    set delivered_at = coalesce(public.message_receipts.delivered_at, excluded.delivered_at),
        read_at = coalesce(public.message_receipts.read_at, excluded.read_at);

  return true;
end;
$$;

alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.message_receipts enable row level security;
alter table public.streaks enable row level security;
alter table public.stories enable row level security;

create policy "Profiles are visible to self and accepted contacts"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.contacts c
      where c.status = 'accepted'
        and ((c.user_id = (select auth.uid()) and c.contact_id = profiles.id)
          or (c.contact_id = (select auth.uid()) and c.user_id = profiles.id))
    )
  );

create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "Contact participants can view their relationship"
  on public.contacts for select to authenticated
  using (user_id = (select auth.uid()) or contact_id = (select auth.uid()));

create policy "Conversation members can view conversations"
  on public.conversations for select to authenticated
  using (public.is_conversation_member(id));

create policy "Conversation members can view memberships"
  on public.conversation_members for select to authenticated
  using (public.is_conversation_member(conversation_id));

create policy "Members can read unexpired conversation messages"
  on public.messages for select to authenticated
  using (
    public.is_conversation_member(conversation_id)
    and (expires_at is null or expires_at > now())
  );

create policy "Members can send messages as themselves"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.is_conversation_member(conversation_id)
  );

create policy "Senders can edit or delete their messages"
  on public.messages for update to authenticated
  using (sender_id = (select auth.uid()) and public.is_conversation_member(conversation_id))
  with check (sender_id = (select auth.uid()) and public.is_conversation_member(conversation_id));

create policy "Members can view message reactions"
  on public.message_reactions for select to authenticated
  using (exists (
    select 1 from public.messages m
    where m.id = message_id and public.is_conversation_member(m.conversation_id)
  ));

create policy "Members can react as themselves"
  on public.message_reactions for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.messages m
      where m.id = message_id and public.is_conversation_member(m.conversation_id)
    )
  );

create policy "Users can remove their own reactions"
  on public.message_reactions for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "Conversation members can view permitted receipts"
  on public.message_receipts for select to authenticated
  using (
    public.is_conversation_member((select m.conversation_id from public.messages m where m.id = message_id))
    and (
      user_id = (select auth.uid())
      or exists (
        select 1 from public.messages m
        join public.profiles reader on reader.id = message_receipts.user_id
        where m.id = message_id
          and m.sender_id = (select auth.uid())
          and reader.read_receipts_enabled
      )
    )
  );

create policy "Users can view streaks in their conversations"
  on public.streaks for select to authenticated
  using (public.is_conversation_member(conversation_id));

create policy "Users can view active stories from accepted contacts"
  on public.stories for select to authenticated
  using (
    expires_at > now()
    and (
      user_id = (select auth.uid())
      or exists (
        select 1 from public.contacts c
        where c.status = 'accepted'
          and ((c.user_id = (select auth.uid()) and c.contact_id = stories.user_id)
            or (c.contact_id = (select auth.uid()) and c.user_id = stories.user_id))
      )
    )
  );

create policy "Users can post their own stories"
  on public.stories for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users can delete their own stories"
  on public.stories for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.profiles, public.contacts, public.conversations,
  public.conversation_members, public.messages, public.message_reactions,
  public.message_receipts, public.streaks, public.stories
  from anon, authenticated;

grant select on public.profiles, public.contacts, public.conversations,
  public.conversation_members, public.messages, public.message_reactions,
  public.message_receipts, public.streaks, public.stories to authenticated;

grant update (username, display_name, avatar_url, hide_online_status,
  read_receipts_enabled, disappearing_messages) on public.profiles to authenticated;
grant insert (conversation_id, sender_id, reply_to_id, type, body, media_path)
  on public.messages to authenticated;
grant update (body, deleted_at) on public.messages to authenticated;
grant insert (message_id, user_id, emoji) on public.message_reactions to authenticated;
grant delete on public.message_reactions to authenticated;
grant insert (user_id, type, content, media_path) on public.stories to authenticated;
grant delete on public.stories to authenticated;

revoke all on function public.new_ziza_number() from public, anon, authenticated;
revoke all on function public.create_profile_for_new_user() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.apply_message_defaults() from public, anon, authenticated;
revoke all on function public.protect_message_update() from public, anon, authenticated;
revoke all on function public.update_chat_streak() from public, anon, authenticated;
revoke all on function public.set_story_expiry() from public, anon, authenticated;
revoke all on function public.is_conversation_member(uuid, uuid) from public, anon;
revoke all on function public.send_contact_request(text) from public, anon;
revoke all on function public.lookup_ziza_number(text) from public, anon;
revoke all on function public.respond_to_contact_request(uuid, boolean) from public, anon;
revoke all on function public.create_direct_conversation(uuid) from public, anon;
revoke all on function public.mark_message_read(uuid) from public, anon;

grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.send_contact_request(text) to authenticated;
grant execute on function public.lookup_ziza_number(text) to authenticated;
grant execute on function public.respond_to_contact_request(uuid, boolean) to authenticated;
grant execute on function public.create_direct_conversation(uuid) to authenticated;
grant execute on function public.mark_message_read(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('chat-media', 'chat-media', false, 26214400,
   array['image/jpeg', 'image/png', 'image/webp', 'audio/webm', 'audio/ogg',
     'audio/mp4', 'application/pdf', 'text/plain',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('story-media', 'story-media', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "Conversation members can read chat media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-media'
    and exists (
      select 1 from public.messages m
      where m.media_path = storage.objects.name
        and m.conversation_id::text = split_part(storage.objects.name, '/', 1)
        and (m.expires_at is null or m.expires_at > now())
        and m.deleted_at is null
        and public.is_conversation_member(m.conversation_id)
    )
  );

create policy "Members can upload media to their conversation folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and split_part(name, '/', 2) = (select auth.uid())::text
    and exists (
      select 1 from public.conversations c
      where c.id::text = split_part(name, '/', 1)
        and public.is_conversation_member(c.id)
    )
  );

create policy "Story owners can upload story media"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'story-media'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

create policy "Accepted contacts can read active story media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'story-media'
    and exists (
      select 1 from public.stories s
      where s.media_path = name
        and s.expires_at > now()
        and (
          s.user_id = (select auth.uid())
          or exists (
            select 1 from public.contacts c
            where c.status = 'accepted'
              and ((c.user_id = (select auth.uid()) and c.contact_id = s.user_id)
                or (c.contact_id = (select auth.uid()) and c.user_id = s.user_id))
          )
        )
    )
  );
