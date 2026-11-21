alter table public.messages
  add column if not exists duration_seconds integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.messages'::regclass
      and conname = 'messages_duration_seconds_check'
  ) then
    alter table public.messages
      add constraint messages_duration_seconds_check
      check (duration_seconds is null or duration_seconds between 1 and 180);
  end if;
end;
$$;

grant insert (duration_seconds) on public.messages to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('chat-media', 'chat-media', false, 26214400,
   array['image/jpeg', 'image/png', 'image/webp', 'audio/webm', 'audio/ogg',
     'audio/mp4', 'application/pdf', 'text/plain',
     'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  ('story-media', 'story-media', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "Members can upload media to their conversation folder" on storage.objects;
create policy "Members can upload media to their conversation folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-media'
    and split_part(name, '/', 2) = (select auth.uid())::text
    and exists (
      select 1
      from public.conversations c
      where c.id::text = split_part(name, '/', 1)
        and public.is_conversation_member(c.id)
        and not exists (
          select 1
          from public.conversation_members other_member
          where other_member.conversation_id = c.id
            and other_member.user_id <> (select auth.uid())
            and public.is_blocked_between(other_member.user_id, (select auth.uid()))
        )
    )
  );

drop policy if exists "Conversation members can read chat media" on storage.objects;
create policy "Conversation members can read chat media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-media'
    and exists (
      select 1
      from public.messages m
      where m.media_path = storage.objects.name
        and m.conversation_id::text = split_part(storage.objects.name, '/', 1)
        and (m.expires_at is null or m.expires_at > now())
        and m.deleted_at is null
        and public.is_conversation_member(m.conversation_id)
    )
  );

drop policy if exists "Story owners can upload story media" on storage.objects;
create policy "Story owners can upload story media"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'story-media'
    and split_part(name, '/', 1) = (select auth.uid())::text
  );

drop policy if exists "Accepted contacts can read active story media" on storage.objects;
create policy "Accepted contacts can read active story media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'story-media'
    and exists (
      select 1
      from public.stories s
      where s.media_path = storage.objects.name
        and s.type = 'image'
        and s.expires_at > now()
        and not public.is_blocked_between(s.user_id, (select auth.uid()))
        and (
          s.user_id = (select auth.uid())
          or exists (
            select 1
            from public.contacts c
            where c.status = 'accepted'
              and (
                (c.user_id = (select auth.uid()) and c.contact_id = s.user_id)
                or (c.contact_id = (select auth.uid()) and c.user_id = s.user_id)
              )
          )
        )
    )
  );
