//10756 is an absolute per-entity snapshot, not a damage-event stream.
// KiBoDuelStore uses owner_id == myPlayerId to identify the player's records
// in an arena, then resolves the battle UUID to source_pet_guid for the UI.
export function npcArenaStatistics(state) {
    const run = state.combat.npcDuel
    return {
        damage_record: Object.values(run.actors).map((actor) => ({
            uuid: actor.uuid,
            owner_id: String(actor.camp === 1 ? state.player.basic_info.id : run.npc_id),
            conf_id: actor.config_id,
            // Arena player_camp1 maps to client SelfCamp6/EnemyCamp5.
            camp: actor.camp === 1 ? 6 : 5,
            damage: 0,
            take_damage: 0,
            heal: 0,
            kill: 0,
            destroy_tower: 0,
            destroy_clam: 0,
            ...run.statistics?.[actor.uuid],
        })),
    }
}

function sourceActor(state, source) {
    const run = state.combat.npcDuel,
        seen = new Set()
    let uuid = String(source ?? '0')
    while (uuid !== '0' && !seen.has(uuid) && seen.size < 16) {
        if (run.actors[uuid]) return run.actors[uuid]
        seen.add(uuid)
        uuid = String(state.combat.summons?.[uuid]?.owner_id ?? state.combat.entities[uuid]?.owner_id ?? '0')
    }
}

export function recordArenaHpStatistics(c, target, source, before, after) {
    const run = c.state.combat?.npcDuel,
        victim = run?.actors[target]
    if (
        !victim ||
        run.map_id !== c.state.world.map_id ||
        c.state.multiCampaign?.arena_status !== 4 ||
        !run.in_fight[target] ||
        !Number.isInteger(before) ||
        !Number.isInteger(after) ||
        before === after
    )
        return
    const attacker = sourceActor(c.state, source)
    // RecordManager.RecordDamage excludes self damage. Count only accepted
    // HP transitions: overkill, overheal and repeated hits on corpses cannot
    // inflate these server statistics. Shield-only damage is not inferred.
    if (after < before && attacker?.uuid === target) return
    const statistics = { ...run.statistics }
    const add = (uuid, key, amount) => {
        const old = statistics[uuid] ?? {}
        statistics[uuid] = { ...old, [key]: Math.min(0xffffffff, (old[key] ?? 0) + amount) }
    }
    if (after < before) {
        add(target, 'take_damage', before - after)
        if (attacker) {
            add(attacker.uuid, 'damage', before - after)
            if (before > 0 && after === 0 && attacker.camp !== victim.camp) add(attacker.uuid, 'kill', 1)
        }
    } else if (attacker) add(attacker.uuid, 'heal', after - before)
    else return
    c.state.combat.npcDuel = { ...run, statistics, statistics_revision: (run.statistics_revision ?? 0) + 1 }
}

export function publishArenaStatistics(c, force = false) {
    const run = c.state.combat?.npcDuel
    if (!run || run.map_id !== c.state.world.map_id) return
    const revision = run.statistics_revision ?? 0
    if (!force && (revision === (run.statistics_synced_revision ?? 0) || run.statistics_sync_at === c.now)) return
    ;(c.pushBefore ?? c.push)('CSProtoKiboDuelStatsSync', npcArenaStatistics(c.state))
    c.state.combat.npcDuel = { ...run, statistics_synced_revision: revision, statistics_sync_at: c.now }
}
