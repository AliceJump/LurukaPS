import { u64 } from './combat-state.js'

function active(c) {
    const run = c.state.combat?.npcDuel
    return run && run.map_id === c.state.world.map_id && !run.result && run.entities_sent !== false ? run : null
}

function currentSummon(c, id, run) {
    const summon = c.state.combat.summons?.[id],
        scope = summon?.native_owner_scope
    return scope?.generation === run.generation && scope?.epoch === (run.origin_epoch ?? 0) ? summon : null
}

function kind(c, id, run) {
    if (run.actors[id]) return 'kibo'
    // A profile entry alone does not establish a spawned HeroEntity.
    if (id === run.trainer_guid) return 'hero'
    const summon = currentSummon(c, id, run)
    return { 1: 'monster', 2: 'item', 3: 'independent', 4: 'kibo', 5: 'monster' }[summon?.summon_type]
}

// CreateSummon.unit_id describes the entity passed to AliveData.SetOwner.
// SetOwner unwraps an IndependentEntity to its stored owner exactly once.
// owner_id remains the separate logical damage-attribution relationship.
export function arenaNativeSummonOwner(c, value) {
    const run = active(c),
        id = u64(value)
    if (!run || id === '0') return { status: 'unobserved' }
    const type = kind(c, id, run)
    if (type === 'independent') {
        const owner = c.state.combat.summons[id].native_owner
        return owner?.status === 'known' ? { ...owner, via: 'independent-owner' } : { status: 'unobserved' }
    }
    return type ? { status: 'known', guid: id, kind: type, via: 'summon-create' } : { status: 'unobserved' }
}

export function arenaUnitGrade(c, value) {
    const run = active(c),
        id = u64(value)
    if (!run || id === '0') return { status: 'unobserved' }
    const type = kind(c, id, run)
    if (type === 'hero') {
        // ChampionFormationData.championStar is populated from heroGrade.
        // Use the grade sent for this arena incarnation, not a later profile edit.
        const value = run.trainer_grade
        return Number.isInteger(value) && value >= 0 && value <= 2147483647
            ? { status: 'resolved', value, via: 'hero-grade', hero: id }
            : { status: 'unobserved' }
    }
    const owner = (run.actors[id] ?? currentSummon(c, id, run))?.native_owner
    // Standard roster creation does not set AliveData.owner. The client owner
    // probe confirms null for both camps; KiBoData.master is a separate field.
    // Older records without this construction metadata remain unobserved.
    if (owner?.status !== 'known') return { status: 'unobserved' }
    if (owner.kind === 'none') return { status: 'resolved', value: 0, via: 'no-native-owner' }
    if (owner.kind !== 'hero') return { status: 'resolved', value: 0, via: 'direct-owner-not-hero' }
    const grade = owner.guid === run.trainer_guid ? run.trainer_grade : undefined
    return Number.isInteger(grade) && grade >= 0 && grade <= 2147483647
        ? { status: 'resolved', value: grade, via: 'owner-hero-grade', hero: owner.guid }
        : { status: 'unobserved' }
}
