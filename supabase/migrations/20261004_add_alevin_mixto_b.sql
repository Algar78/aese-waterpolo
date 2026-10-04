-- AESE Waterpolo · Alta de Alevín Mixto B
-- Usa la categoría ya asociada a Alevín Mixto A y crea el nuevo equipo
-- para la temporada actual, reutilizando jugadores existentes por nombre.
-- No contiene claves secretas.

do $$
declare
  v_season uuid;
  v_category uuid;
  v_team uuid;
  v_player uuid;
  v_name text;
  v_names text[] := array[
    'Adriana Puig Moreno',
    'Bryce Villarroel Alba',
    'Carla Freixanet Gran',
    'Carla Guillen Prieto',
    'Hugo Carrasco Ferreiro',
    'Julen Vigara Silvan',
    'Juno Abella Perez',
    'Marc Esteras Contreras',
    'Odett Ileana Dutu Cucunuba',
    'Sergi Lopez Jimenez',
    'Valeria Botia Valenzuela'
  ];
begin
  select id
    into v_season
  from public.seasons
  where is_current = true
  order by starts_on desc nulls last
  limit 1;

  if v_season is null then
    raise exception 'No existe una temporada actual.';
  end if;

  select category_id
    into v_category
  from public.teams
  where name = 'Alevín Mixto A'
  limit 1;

  if v_category is null then
    raise exception 'No se ha encontrado Alevín Mixto A para reutilizar su categoría.';
  end if;

  select id
    into v_team
  from public.teams
  where name = 'Alevín Mixto B'
  limit 1;

  if v_team is null then
    insert into public.teams (
      category_id, code, name, squad_label, is_active
    )
    values (
      v_category, 'ALEVIN_MIXTO_B', 'Alevín Mixto B', 'Alevín Mixto B', true
    )
    returning id into v_team;
  else
    update public.teams
    set category_id = v_category,
        code = 'ALEVIN_MIXTO_B',
        squad_label = 'Alevín Mixto B',
        is_active = true
    where id = v_team;
  end if;

  foreach v_name in array v_names loop
    select id
      into v_player
    from public.players
    where lower(full_name) = lower(v_name)
    limit 1;

    if v_player is null then
      insert into public.players (full_name)
      values (v_name)
      returning id into v_player;
    end if;

    if not exists (
      select 1
      from public.team_players tp
      where tp.season_id = v_season
        and tp.team_id = v_team
        and tp.player_id = v_player
    ) then
      insert into public.team_players (
        season_id, team_id, player_id, is_active
      )
      values (
        v_season, v_team, v_player, true
      );
    else
      update public.team_players
      set is_active = true
      where season_id = v_season
        and team_id = v_team
        and player_id = v_player;
    end if;
  end loop;
end $$;

-- Verificación: debe devolver Alevín Mixto B con 11 jugadores activos.
select
  t.name as equipo,
  count(tp.id) as jugadores_activos
from public.teams t
left join public.team_players tp
  on tp.team_id = t.id
 and tp.is_active = true
 and tp.season_id = (select id from public.seasons where is_current = true limit 1)
where t.name = 'Alevín Mixto B'
group by t.name;
