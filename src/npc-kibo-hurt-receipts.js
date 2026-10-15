import { ensure } from './handlers/common.js'

// DamageService.AddDamageData uses one client-global counter,1..int.MaxValue.
// A new element, target or request sequence does not start a new counter.
// Ranges retain every accepted index for this entity generation; the recent
// payload cache is only for conflict diagnostics, never duplicate retention.
export function arenaHurtIsDuplicate(c, hurt) {
    const run = c.state.combat?.npcDuel
    if (
        !run ||
        run.map_id !== c.state.world.map_id ||
        run.result ||
        c.state.multiCampaign?.arena_status !== 4 ||
        run.pause ||
        run.ai_control?.[0] === 1 ||
        run.ai_control?.[2] === 1 ||
        !run.actors[hurt.tar_id] ||
        !run.in_fight[hurt.tar_id]
    )
        return false
    const index = hurt.dmg_inc_id ?? 0
    // Old/unsequenced reports cannot be deduplicated by matching their damage
    // value: two legitimate hits can have identical skill/element/HP deltas.
    if (index === 0) return false
    ensure(Number.isInteger(index) && index > 0 && index <= 2147483647, 'Invalid arena damage index')
    const prior = run.hurt_receipts ?? { ranges: [], recent: {}, order: [] }
    const fingerprint = JSON.stringify([
        hurt.from_id,
        hurt.tar_id,
        hurt.skill_id ?? 0,
        hurt.hp_change ?? null,
        hurt.element_uniqueId ?? '0',
        hurt.element_tempId ?? 0,
    ])
    let lo = 0,
        hi = prior.ranges.length
    while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (prior.ranges[mid][1] < index) lo = mid + 1
        else hi = mid
    }
    if (prior.ranges[lo]?.[0] <= index) {
        ensure(
            prior.recent[index] === undefined || prior.recent[index] === fingerprint,
            'Conflicting arena damage index',
        )
        return true
    }
    const ranges = prior.ranges.slice()
    const left = lo > 0 && ranges[lo - 1][1] + 1 === index
    const right = ranges[lo]?.[0] === index + 1
    if (left && right) ranges.splice(lo - 1, 2, [ranges[lo - 1][0], ranges[lo][1]])
    else if (left) ranges[lo - 1] = [ranges[lo - 1][0], index]
    else if (right) ranges[lo] = [index, ranges[lo][1]]
    else ranges.splice(lo, 0, [index, index])
    const recent = { ...prior.recent, [index]: fingerprint },
        order = [...prior.order, index]
    if (order.length > 512) delete recent[order.shift()]
    c.state.combat.npcDuel = { ...run, hurt_receipts: { ranges, recent, order } }
    return false
}
