drop policy if exists "Profiles are visible to self and accepted contacts"
  on public.profiles;
drop policy if exists "Profiles are visible to self and request participants"
  on public.profiles;
drop policy if exists "Profiles are visible to self and contact request participants"
  on public.profiles;

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
