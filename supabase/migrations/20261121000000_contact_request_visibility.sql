drop policy if exists "Profiles are visible to self and accepted contacts" on public.profiles;
create policy "Profiles are visible to self and contact request participants"
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or (
      not public.is_blocked_between(id, (select auth.uid()))
      and exists (
        select 1
        from public.contacts c
        where c.status in ('pending', 'accepted')
          and (
            (c.user_id = (select auth.uid()) and c.contact_id = profiles.id)
            or (c.contact_id = (select auth.uid()) and c.user_id = profiles.id)
          )
      )
    )
  );

drop policy if exists "Contact participants can view their relationship" on public.contacts;
create policy "Contact participants can view their relationship"
  on public.contacts for select to authenticated
  using (user_id = (select auth.uid()) or contact_id = (select auth.uid()));

create policy "Recipients can respond to pending contact requests"
  on public.contacts for update to authenticated
  using (contact_id = (select auth.uid()) and status = 'pending')
  with check (
    contact_id = (select auth.uid())
    and status in ('accepted', 'rejected')
  );

create policy "Recipients can delete pending contact requests"
  on public.contacts for delete to authenticated
  using (contact_id = (select auth.uid()) and status = 'pending');

grant select on public.contacts to authenticated;
grant update (status, accepted_at) on public.contacts to authenticated;
grant delete on public.contacts to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'contacts'
    ) then
    alter publication supabase_realtime add table public.contacts;
  end if;
end;
$$;
