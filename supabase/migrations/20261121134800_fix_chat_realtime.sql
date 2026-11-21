do $$
declare
  v_table text;
begin
  if not exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'The supabase_realtime publication does not exist';
  end if;

  if to_regclass('public.messages') is null then
    raise exception 'The public.messages table does not exist';
  end if;

  foreach v_table in array array[
    'messages',
    'conversations',
    'contacts',
    'friend_requests',
    'stories'
  ] loop
    if to_regclass(format('public.%I', v_table)) is not null then
      begin
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      exception
        when duplicate_object then null;
      end;
    end if;
  end loop;

  execute 'alter table public.messages replica identity full';
end;
$$;
