alter table public.conversation_members
  add column last_read_at timestamptz not null default now();

alter table public.streaks
  add column user_a_last_message_at timestamptz,
  add column user_b_last_message_at timestamptz,
  add column last_completed_at timestamptz;

update public.streaks
set user_a_last_message_at = user_a_last_message_date::timestamp at time zone 'UTC',
    user_b_last_message_at = user_b_last_message_date::timestamp at time zone 'UTC',
    last_completed_at = last_completed_date::timestamp at time zone 'UTC';

create table public.blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.blocks enable row level security;
create policy "Users can view blocks they created"
  on public.blocks for select to authenticated
  using (blocker_id = (select auth.uid()));

revoke all on public.blocks from anon, authenticated;
grant select on public.blocks to authenticated;

create function public.is_blocked_between(p_first uuid, p_second uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_first and b.blocked_id = p_second)
       or (b.blocker_id = p_second and b.blocked_id = p_first)
  );
$$;

create function public.block_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_user_id = auth.uid() then
    raise exception 'A valid account is required';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'User not found';
  end if;
  insert into public.blocks (blocker_id, blocked_id)
  values (auth.uid(), p_user_id)
  on conflict do nothing;
end;
$$;

create function public.unblock_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  delete from public.blocks
  where blocker_id = auth.uid() and blocked_id = p_user_id;
end;
$$;

create function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_receipts_enabled boolean;
begin
  if v_user_id is null or not public.is_conversation_member(p_conversation_id, v_user_id) then
    raise exception 'Conversation not found or unavailable';
  end if;

  update public.conversation_members
  set last_read_at = now()
  where conversation_id = p_conversation_id and user_id = v_user_id;

  select p.read_receipts_enabled into v_receipts_enabled
  from public.profiles p where p.id = v_user_id;
  if coalesce(v_receipts_enabled, false) then
    insert into public.message_receipts (message_id, user_id, delivered_at, read_at)
    select m.id, v_user_id, now(), now()
    from public.messages m
    where m.conversation_id = p_conversation_id
      and m.sender_id <> v_user_id
      and m.deleted_at is null
      and (m.expires_at is null or m.expires_at > now())
    on conflict (message_id, user_id) do update
      set delivered_at = coalesce(public.message_receipts.delivered_at, excluded.delivered_at),
          read_at = coalesce(public.message_receipts.read_at, excluded.read_at);
  end if;
end;
$$;

drop trigger messages_update_streak on public.messages;
create or replace function public.update_chat_streak()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_participants uuid[];
  v_streak public.streaks%rowtype;
  v_completed_at timestamptz;
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

  if v_streak.expires_at is not null and new.created_at >= v_streak.expires_at then
    v_streak.current_count := 0;
    v_streak.last_completed_at := null;
    v_streak.user_a_last_message_at := null;
    v_streak.user_b_last_message_at := null;
    v_streak.expires_at := null;
  end if;

  if new.sender_id = v_streak.user_a then
    v_streak.user_a_last_message_at := new.created_at;
  elsif new.sender_id = v_streak.user_b then
    v_streak.user_b_last_message_at := new.created_at;
  else
    return new;
  end if;

  if v_streak.expires_at is null then
    v_streak.expires_at := new.created_at + interval '24 hours';
  end if;

  if v_streak.user_a_last_message_at is not null
    and v_streak.user_b_last_message_at is not null
    and v_streak.user_a_last_message_at > coalesce(v_streak.last_completed_at, '-infinity'::timestamptz)
    and v_streak.user_b_last_message_at > coalesce(v_streak.last_completed_at, '-infinity'::timestamptz) then
    v_completed_at := greatest(v_streak.user_a_last_message_at, v_streak.user_b_last_message_at);
    if v_completed_at <= v_streak.expires_at then
      v_streak.current_count := v_streak.current_count + 1;
      v_streak.last_completed_at := v_completed_at;
      v_streak.expires_at := v_completed_at + interval '24 hours';
      v_streak.user_a_last_message_at := null;
      v_streak.user_b_last_message_at := null;
    else
      v_streak.current_count := 0;
      v_streak.last_completed_at := null;
      v_streak.user_a_last_message_at := case when new.sender_id = v_streak.user_a then new.created_at else null end;
      v_streak.user_b_last_message_at := case when new.sender_id = v_streak.user_b then new.created_at else null end;
      v_streak.expires_at := new.created_at + interval '24 hours';
    end if;
  end if;

  update public.streaks
  set user_a_last_message_at = v_streak.user_a_last_message_at,
      user_b_last_message_at = v_streak.user_b_last_message_at,
      last_completed_at = v_streak.last_completed_at,
      current_count = v_streak.current_count,
      expires_at = v_streak.expires_at
  where conversation_id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_update_streak
  after insert on public.messages
  for each row execute function public.update_chat_streak();

drop policy "Profiles are visible to self and accepted contacts" on public.profiles;
create policy "Profiles are visible to self and accepted contacts"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or (
      not public.is_blocked_between(id, (select auth.uid()))
      and exists (
        select 1 from public.contacts c
        where c.status = 'accepted'
          and ((c.user_id = (select auth.uid()) and c.contact_id = profiles.id)
            or (c.contact_id = (select auth.uid()) and c.user_id = profiles.id))
      )
    )
  );

drop policy "Users can view active stories from accepted contacts" on public.stories;
create policy "Users can view active stories from accepted contacts"
  on public.stories for select to authenticated
  using (
    expires_at > now()
    and not public.is_blocked_between(user_id, (select auth.uid()))
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

drop policy "Members can send messages as themselves" on public.messages;
create policy "Members can send messages as themselves"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.is_conversation_member(conversation_id)
    and not exists (
      select 1 from public.conversation_members other_member
      where other_member.conversation_id = messages.conversation_id
        and other_member.user_id <> (select auth.uid())
        and public.is_blocked_between(other_member.user_id, (select auth.uid()))
    )
  );

drop policy "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "Users can advance their own conversation read cursor"
  on public.conversation_members for update to authenticated
  using (user_id = (select auth.uid()) and public.is_conversation_member(conversation_id))
  with check (user_id = (select auth.uid()) and public.is_conversation_member(conversation_id));

grant update (last_read_at) on public.conversation_members to authenticated;

create or replace function public.send_contact_request(p_ziza_number text)
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
  if public.is_blocked_between(v_requester, v_contact) then
    raise exception 'This contact request is unavailable';
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

create or replace function public.lookup_ziza_number(p_ziza_number text)
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
    and p.id <> auth.uid()
    and not public.is_blocked_between(p.id, auth.uid());
end;
$$;

create or replace function public.create_direct_conversation(p_contact_id uuid)
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
  if public.is_blocked_between(v_user_id, p_contact_id) then
    raise exception 'This conversation is unavailable';
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

grant execute on function public.is_blocked_between(uuid, uuid) to authenticated;
revoke all on function public.is_blocked_between(uuid, uuid) from public, anon;
grant execute on function public.block_user(uuid) to authenticated;
revoke all on function public.block_user(uuid) from public, anon;
grant execute on function public.unblock_user(uuid) to authenticated;
revoke all on function public.unblock_user(uuid) from public, anon;
grant execute on function public.mark_conversation_read(uuid) to authenticated;
revoke all on function public.mark_conversation_read(uuid) from public, anon;

create policy "Conversation members can access private realtime topics"
  on realtime.messages for all to authenticated
  using (
    case
      when realtime.topic() ~ '^ziza:conversation:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.is_conversation_member(split_part(realtime.topic(), ':', 3)::uuid)
        and not exists (
          select 1 from public.conversation_members other_member
          where other_member.conversation_id = split_part(realtime.topic(), ':', 3)::uuid
            and other_member.user_id <> (select auth.uid())
            and public.is_blocked_between(other_member.user_id, (select auth.uid()))
        )
      else false
    end
  )
  with check (
    case
      when realtime.topic() ~ '^ziza:conversation:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.is_conversation_member(split_part(realtime.topic(), ':', 3)::uuid)
        and not exists (
          select 1 from public.conversation_members other_member
          where other_member.conversation_id = split_part(realtime.topic(), ':', 3)::uuid
            and other_member.user_id <> (select auth.uid())
            and public.is_blocked_between(other_member.user_id, (select auth.uid()))
        )
      else false
    end
  );

-- alter table realtime.messages enable row level security;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
    ) then
      alter publication supabase_realtime add table public.messages;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contacts'
    ) then
      alter publication supabase_realtime add table public.contacts;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
    ) then
      alter publication supabase_realtime add table public.conversations;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_members'
    ) then
      alter publication supabase_realtime add table public.conversation_members;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stories'
    ) then
      alter publication supabase_realtime add table public.stories;
    end if;
  end if;
end;
$$;
