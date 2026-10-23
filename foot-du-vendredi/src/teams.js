'use strict';
/**
 * Module équipes — tirage équilibré et persistance.
 *
 * Principe du tirage :
 *   1. Seuls les joueurs présents (ou inscrits, si les présences ne sont pas encore renseignées)
 *      participent au tirage.
 *   2. Chaque joueur reçoit un « poids » basé sur son niveau (abonné > non abonné) et
 *      ses participations (expérience).
 *   3. Le tirage répartit les joueurs dans N équipes en alternant les meilleurs profils
 *      (serpentin) après mélange aléatoire dans chaque strate — ainsi chaque équipe reçoit
 *      un mélange homogène.
 *   4. Le résultat peut être sauvegardé (tables `teams` + `team_members`) et rechargé.
 */

/** Couleurs proposées par défaut pour les équipes (ordre stable). */
const TEAM_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];
const TEAM_NAMES  = ['Équipe Rouge', 'Équipe Bleue', 'Équipe Verte', 'Équipe Orange', 'Équipe Violette', 'Équipe Cyan'];

/**
 * Poids d'un joueur pour le tirage (plus c'est élevé, meilleur est le joueur « a priori »).
 * tier : 'annual' | 'loyalty' | 'loyalty_upgrade' | 'standard'
 * participations : nombre de participations validées sur la saison
 */
function playerWeight(reg) {
  const tierScore = { annual: 3, loyalty: 2, loyalty_upgrade: 1, standard: 0 }[reg.tier] ?? 0;
  const partScore = Math.min(reg.participations || 0, 20); // plafonné pour éviter l'effet « anciens uniquement »
  return tierScore * 10 + partScore;
}

/**
 * Mélange aléatoire (Fisher-Yates).
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Tirage par serpentin équilibré.
 *
 * @param {Array}  players  — liste d'objets { registration_id, tier, participations, first_name }
 * @param {number} n        — nombre d'équipes (2 à 6)
 * @returns {Array}         — tableau de n tableaux de registration_id
 */
function drawTeams(players, n) {
  if (n < 2 || n > 6) throw new RangeError("Nombre d'équipes invalide (2 à 6).");
  if (!players.length) return Array.from({ length: n }, () => []);

  // Tri par poids décroissant, puis mélange aléatoire à l'intérieur de chaque strate (groupes de n)
  const sorted = [...players].sort((a, b) => playerWeight(b) - playerWeight(a));
  // Mélanger à l'intérieur de chaque « rangée » du serpentin pour un peu de variété
  const rows = [];
  for (let i = 0; i < sorted.length; i += n) rows.push(shuffle(sorted.slice(i, i + n)));

  const teams = Array.from({ length: n }, () => []);
  rows.forEach((row, rowIdx) => {
    // Sens alternes : rangée paire → 0..n-1, rangée impaire → n-1..0 (serpentin)
    const indices = rowIdx % 2 === 0 ? row.map((_, j) => j) : row.map((_, j) => n - 1 - j);
    row.forEach((player, j) => {
      const teamIdx = indices[j];
      if (teamIdx < n) teams[teamIdx].push(player.registration_id);
    });
  });
  return teams;
}

/**
 * Crée les functions de repo pour les équipes.
 * @param {DatabaseSync} db
 */
function createTeamsRepo(db) {
  const q = {
    teamsByMatch:   db.prepare('SELECT * FROM teams WHERE match_id = ? ORDER BY position, id'),
    membersByTeam:  db.prepare(`
      SELECT tm.team_id, tm.registration_id, tm.position,
             r.first_name AS player_name, r.player_id, r.tier, r.attendance,
             p.first_name AS player_first_name
      FROM team_members tm
      JOIN registrations r ON r.id = tm.registration_id
      LEFT JOIN players p ON p.id = r.player_id
      ORDER BY tm.position, tm.registration_id`),
    membersByMatch: db.prepare(`
      SELECT tm.team_id, tm.registration_id, tm.position,
             r.first_name AS player_name, r.player_id, r.tier, r.attendance,
             p.first_name AS player_first_name
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      JOIN registrations r ON r.id = tm.registration_id
      LEFT JOIN players p ON p.id = r.player_id
      WHERE t.match_id = ?
      ORDER BY tm.position, tm.registration_id`),
    regsByMatch: db.prepare(`
      SELECT r.id AS registration_id, r.player_id, r.tier, r.attendance,
             r.first_name AS reg_name, p.first_name AS player_name,
             COALESCE(
               (SELECT COUNT(*) FROM registrations r2
                JOIN matches m2 ON m2.id = r2.match_id
                WHERE r2.player_id = r.player_id AND r2.attendance = 'present'
                  AND m2.season_id = (SELECT season_id FROM matches WHERE id = r.match_id)),
               0
             ) AS participations
      FROM registrations r
      LEFT JOIN players p ON p.id = r.player_id
      WHERE r.match_id = ?
      ORDER BY r.created_at, r.id`),
    insertTeam:   db.prepare('INSERT INTO teams (match_id, name, color, position) VALUES (?, ?, ?, ?)'),
    insertMember: db.prepare('INSERT INTO team_members (team_id, registration_id, position) VALUES (?, ?, ?)'),
    deleteTeams:  db.prepare('DELETE FROM teams WHERE match_id = ?'),
  };

  /**
   * Lire les équipes sauvegardées pour un match.
   * Renvoie null si aucune équipe n'a été tirée.
   */
  function getTeams(matchId) {
    const teams = q.teamsByMatch.all(matchId);
    if (!teams.length) return null;
    const members = q.membersByMatch.all(matchId);
    const byTeam = new Map(teams.map((t) => [t.id, []]));
    for (const m of members) {
      if (byTeam.has(m.team_id)) byTeam.get(m.team_id).push({
        registration_id: m.registration_id,
        player_id: m.player_id,
        first_name: m.player_first_name || m.player_name,
        tier: m.tier,
        attendance: m.attendance,
      });
    }
    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      position: t.position,
      members: byTeam.get(t.id) || [],
    }));
  }

  /**
   * Tirer et sauvegarder les équipes pour un match.
   * @param {number} matchId
   * @param {number} numTeams  — nombre d'équipes souhaité
   * @param {string} pool      — 'present' (présents uniquement), 'registered' (tous inscrits)
   * @param {Array}  [names]   — noms personnalisés des équipes (optionnel)
   * @param {Array}  [colors]  — couleurs personnalisées (optionnel)
   */
  function saveTeams(matchId, numTeams, pool, names, colors) {
    const n = Number(numTeams);
    if (!Number.isInteger(n) || n < 2 || n > 6) throw new RangeError("Nombre d'équipes invalide (2 à 6).");

    // Joueurs éligibles
    let regs = q.regsByMatch.all(matchId);
    if (pool === 'present') {
      const hasPresent = regs.some((r) => r.attendance === 'present');
      if (hasPresent) regs = regs.filter((r) => r.attendance === 'present');
      // sinon on prend tous les inscrits (présences non encore renseignées)
    }

    // Tirage
    const groups = drawTeams(regs, n);

    // Noms et couleurs
    const resolvedNames  = Array.from({ length: n }, (_, i) => (names  && names[i])  || TEAM_NAMES[i]  || `Équipe ${i + 1}`);
    const resolvedColors = Array.from({ length: n }, (_, i) => (colors && colors[i]) || TEAM_COLORS[i] || '');

    // Persistance (transaction)
    db.exec('BEGIN IMMEDIATE');
    try {
      q.deleteTeams.run(matchId);
      for (let i = 0; i < n; i++) {
        const teamId = Number(q.insertTeam.run(matchId, resolvedNames[i], resolvedColors[i], i).lastInsertRowid);
        groups[i].forEach((regId, pos) => q.insertMember.run(teamId, regId, pos));
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    return getTeams(matchId);
  }

  /**
   * Mettre à jour manuellement la composition des équipes (drag-and-drop).
   * `teams` est un tableau : [{ id, name, color, members: [registration_id, …] }, …]
   */
  function updateTeams(matchId, teamsData) {
    if (!Array.isArray(teamsData) || teamsData.length < 2 || teamsData.length > 6) {
      throw new RangeError('Composition invalide.');
    }
    // Vérifier que tous les IDs d'équipes appartiennent bien au match
    const existing = q.teamsByMatch.all(matchId);
    const existingIds = new Set(existing.map((t) => t.id));

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [pos, t] of teamsData.entries()) {
        const id = Number(t.id);
        if (!existingIds.has(id)) throw new RangeError('Équipe inconnue.');
        const name  = String(t.name  || '').trim().slice(0, 40) || `Équipe ${pos + 1}`;
        const color = String(t.color || '').trim().slice(0, 20);
        db.prepare('UPDATE teams SET name = ?, color = ?, position = ? WHERE id = ?').run(name, color, pos, id);
        db.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
        const members = Array.isArray(t.members) ? t.members : [];
        members.forEach((regId, mpos) => {
          db.prepare('INSERT INTO team_members (team_id, registration_id, position) VALUES (?, ?, ?)').run(id, regId, mpos);
        });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    return getTeams(matchId);
  }

  /** Supprimer les équipes d'un match. */
  function deleteTeams(matchId) {
    q.deleteTeams.run(matchId);
  }

  /** Inscrits éligibles pour affichage dans l'éditeur (tous, avec infos de niveau). */
  function eligiblePlayers(matchId) {
    return q.regsByMatch.all(matchId).map((r) => ({
      registration_id: r.registration_id,
      player_id: r.player_id,
      first_name: r.player_name || r.reg_name,
      tier: r.tier,
      attendance: r.attendance,
      participations: r.participations,
      weight: playerWeight(r),
    }));
  }

  return { getTeams, saveTeams, updateTeams, deleteTeams, eligiblePlayers, TEAM_COLORS, TEAM_NAMES };
}

module.exports = { createTeamsRepo, drawTeams, TEAM_COLORS, TEAM_NAMES };
