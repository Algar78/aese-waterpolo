(function () {
  async function getCurrentSeasonRoster() {
    const authState = window.AESE_AUTH;
    if (!authState || !authState.session || !authState.client) {
      throw new Error("Inicia sesión para consultar las plantillas de Supabase.");
    }

    const client = authState.client;
    const seasonResult = await client
      .from("seasons")
      .select("id,code,name,starts_on,ends_on")
      .eq("is_current", true)
      .single();
    if (seasonResult.error) throw seasonResult.error;

    const rosterResult = await client
      .from("team_players")
      .select("id,season_id,team_id,player_id,teams!inner(id,category_id,code,name,squad_label,is_active,categories!inner(id,code,name,gender)),players!inner(id,full_name)")
      .eq("season_id", seasonResult.data.id)
      .eq("is_active", true)
      .eq("teams.is_active", true)
      .order("created_at", { ascending: true });
    if (rosterResult.error) throw rosterResult.error;

    const teamsById = new Map();
    rosterResult.data.forEach(function (membership) {
      const team = membership.teams;
      if (!teamsById.has(team.id)) {
        teamsById.set(team.id, {
          id: team.id,
          teamId: team.id,
          seasonId: membership.season_id,
          categoryId: team.category_id,
          code: team.code,
          name: team.name,
          squadLabel: team.squad_label,
          category: team.categories,
          players: []
        });
      }
      teamsById.get(team.id).players.push({
        membershipId: membership.id,
        playerId: membership.players.id,
        name: membership.players.full_name,
      });
    });

    return {
      season: seasonResult.data,
      teams: Array.from(teamsById.values())
    };
  }

  window.AESE_ROSTERS = { getCurrentSeasonRoster };
})();
