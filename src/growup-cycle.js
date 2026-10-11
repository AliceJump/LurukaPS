import { ensure } from './handlers/common.js'
const ids = (text) =>
    String(text ?? '')
        .split('|')
        .filter(Boolean)
        .map(Number)
export function assistantLevel(system, assistant) {
    const rows = system.tables
        .get('game_events_cul_assistlevel')
        .filter((x) => x.assisId === assistant.assist_char_id)
        .sort((a, b) => a.bondLevel - b.bondLevel)
    ensure(rows.length, 'Cultivation assistant level table missing', 1007)
    // TDGameEventsCulAssistlevelTable.GetLevel returns the FIRST level whose
    // needPoints is greater than the stored points, not the last passed row.
    return rows.find((x) => assistant.bond < x.needPoints) ?? rows.at(-1)
}
export function prepareGrowupCycle(system, entry, id, randomInt) {
    const g = entry.growup
    const key = `${g.guid}:${g.cur_stage}:${g.cur_growup_stage}:${g.action_count}`
    const runtime = (entry.growupRuntime ??= {})
    if (runtime.cycle === key) return false
    for (const option of g.train_options) option.assist_char_ids = []
    for (const assistant of g.assist_chars) {
        const row = assistantLevel(system, assistant)
        const choices = String(row.assistTrainWeight)
            .split('|')
            .map((x) => {
                const [option, weight] = x.split('#').map(Number)
                return { option, weight }
            })
        const choice = system.weighted(choices, 'weight', randomInt)
        const option = g.train_options.find((x) => x.train_option_id === choice.option)
        if (option) option.assist_char_ids.push(assistant.assist_char_id)
        assistant.is_bond_train = row.bondTrainProbability > 0 && randomInt(10000) < row.bondTrainProbability
    }
    runtime.cycle = key
    return true
}
export function populateGrowupEvents(system, g, id, randomInt) {
    const rows = system.tables.get('game_events_cul_event').filter((x) => x.systemId === id)
    const old = g.event_datas ?? [],
        offered = old.filter((x) => !x.finish && x.duration > 0)
    const records = new Map(g.evt_records.map((x) => [x.id, x.complete_cnt]))
    const available = rows.filter(
        (row) => system.condition(row.unlockCondition, g) && (records.get(row.id) ?? 0) < row.repeattime,
    )
    const wire = (row) => ({
        event_id: row.id,
        cur_step: 0,
        finish: false,
        event_option_ids: [],
        duration: row.duration,
    })
    for (const row of available.filter((x) => x.eventType === 2)) {
        if (!old.some((x) => x.event_id === row.id && x.finish) && !offered.some((x) => x.event_id === row.id))
            offered.push(wire(row))
    }
    const occupied = new Set(offered.map((x) => rows.find((r) => r.id === x.event_id)?.postype))
    const pools = new Map()
    for (const row of available.filter((x) => x.eventType === 3 && x.randweight > 0 && !occupied.has(x.postype))) {
        const unlocked =
            g.unlock_events.includes(row.id) ||
            (row.heroId > 0 && g.assist_chars.some((x) => x.assist_char_id === row.heroId))
        if (!unlocked) continue
        const pool = pools.get(row.postype) ?? []
        pool.push(row)
        pools.set(row.postype, pool)
    }
    for (const pool of pools.values()) offered.push(wire(system.weighted(pool, 'randweight', randomInt)))
    g.event_datas = offered
}
export function growupCommonTriggers(system, g, id, context, randomInt) {
    const triggers = system.tables.get('game_events_cul_commontrigger').filter((x) => x.systemId === id)
    const effects = system.tables.get('game_events_cul_commoneffect').filter((x) => x.systemId === id)
    const done = new Set()
    for (const trigger of triggers) {
        const [kind, variant, result, detail] = ids(trigger.triggertiming)
        if (
            kind !== context.kind ||
            (variant !== context.variant && !(kind === 1 && variant === 5)) ||
            (result && result !== context.result) ||
            (detail && detail !== context.detail)
        )
            continue
        const candidates = effects.filter((x) => ids(x.triggertimingid).includes(trigger.triggertimingid))
        const groups = new Map()
        for (const row of candidates) {
            const pool = groups.get(row.commoneventgroup) ?? []
            pool.push(row)
            groups.set(row.commoneventgroup, pool)
        }
        for (const [group, pool] of groups) {
            if (done.has(group)) continue
            done.add(group)
            if (randomInt(10000) >= trigger.triggerchance) continue
            const chosen = pool.length === 1 ? pool[0] : system.weighted(pool, 'weight', randomInt)
            system.effects(g, id, chosen.triggereffect)
        }
    }
}
