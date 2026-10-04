-- AESE Waterpolo · Fase 1 · Roles, propiedad de partidos y RLS
-- Ejecutar en Supabase > SQL Editor sobre el proyecto real.
-- No contiene ninguna clave secreta.

create schema if not exists private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('admin','user')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

insert into public.profiles (id, role)
select id, 'user'
from auth.users
on conflict (id) do nothing;

update public.profiles
set role = 'admin', updated_at = now()
where lower(id::text) = lower(id::text)
  and exists (
    select 1 from auth.users u
    where u.id = public.profiles.id
      and lower(coalesce(u.email,'')) = lower('algarri1978@gmail.com')
  );

alter table public.matches
  add column if not exists created_by uuid references auth.users(id) on delete set null;

update public.matches
set created_by = null
where created_by is not null
  and not exists (select 1 from auth.users u where u.id = public.matches.created_by);

create index if not exists matches_created_by_idx on public.matches(created_by);

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

revoke all on function private.is_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'user')
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Reemplazamos las políticas de las tablas usadas por la app.
-- Esto evita conservar por accidente una política antigua más permisiva.
do $$
declare
  t text;
  p record;
  tables text[] := array[
    'profiles','seasons','categories','teams','players','team_players',
    'matches','match_players'
  ];
begin
  foreach t in array tables loop
    if to_regclass('public.' || t) is not null then
      for p in
        select policyname
        from pg_policies
        where schemaname = 'public' and tablename = t
      loop
        execute format('drop policy if exists %I on public.%I', p.policyname, t);
      end loop;
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;

revoke all on table public.profiles from anon;
grant select on table public.profiles to authenticated;

create policy "profiles_select_own_or_admin"
on public.profiles for select
to authenticated
using ((select auth.uid()) = id or (select private.is_admin()));

create policy "profiles_update_admin"
on public.profiles for update
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

revoke all on table public.seasons, public.categories, public.teams, public.players, public.team_players from anon;
grant select on table public.seasons, public.categories, public.teams, public.players, public.team_players to authenticated;

create policy "seasons_select_authenticated" on public.seasons
for select to authenticated using (true);
create policy "categories_select_authenticated" on public.categories
for select to authenticated using (true);
create policy "teams_select_authenticated" on public.teams
for select to authenticated using (true);
create policy "players_select_authenticated" on public.players
for select to authenticated using (true);
create policy "team_players_select_authenticated" on public.team_players
for select to authenticated using (true);

create policy "seasons_admin_write" on public.seasons
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));
create policy "categories_admin_write" on public.categories
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));
create policy "teams_admin_write" on public.teams
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));
create policy "players_admin_write" on public.players
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));
create policy "team_players_admin_write" on public.team_players
for all to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));

revoke all on table public.matches from anon;
grant select, insert, update on table public.matches to authenticated;
grant delete on table public.matches to authenticated;

create policy "matches_select_authenticated"
on public.matches for select
to authenticated
using (true);

create policy "matches_insert_own"
on public.matches for insert
to authenticated
with check ((select auth.uid()) = created_by);

create policy "matches_update_own_or_admin"
on public.matches for update
to authenticated
using ((select auth.uid()) = created_by or (select private.is_admin()))
with check ((select auth.uid()) = created_by or (select private.is_admin()));

create policy "matches_delete_admin"
on public.matches for delete
to authenticated
using ((select private.is_admin()));

revoke all on table public.match_players from anon;
grant select, insert, update on table public.match_players to authenticated;
grant delete on table public.match_players to authenticated;

create policy "match_players_select_authenticated"
on public.match_players for select
to authenticated
using (true);

create policy "match_players_insert_own_match_or_admin"
on public.match_players for insert
to authenticated
with check (
  (select private.is_admin())
  or exists (
    select 1 from public.matches m
    where m.id = match_players.match_id
      and m.created_by = (select auth.uid())
  )
);

create policy "match_players_update_own_match_or_admin"
on public.match_players for update
to authenticated
using (
  (select private.is_admin())
  or exists (
    select 1 from public.matches m
    where m.id = match_players.match_id
      and m.created_by = (select auth.uid())
  )
)
with check (
  (select private.is_admin())
  or exists (
    select 1 from public.matches m
    where m.id = match_players.match_id
      and m.created_by = (select auth.uid())
  )
);

create policy "match_players_delete_admin"
on public.match_players for delete
to authenticated
using ((select private.is_admin()));

-- Comprobación básica: el administrador esperado debe existir.
do $$
begin
  if not exists (
    select 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where lower(coalesce(u.email,'')) = lower('algarri1978@gmail.com')
      and p.role = 'admin'
  ) then
    raise exception 'No se ha encontrado algarri1978@gmail.com en auth.users; no se ha podido asignar el rol admin.';
  end if;
end $$;
