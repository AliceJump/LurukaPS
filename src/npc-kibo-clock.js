import { ensure } from './handlers/common.js'
import { pairs } from './battle.js'

export function arenaTiming(tables, duelId) {
    const duel = tables.find('kibo_duel', duelId),
        cost = pairs(duel.cost)
    const initial = cost.get(307),
        max = cost.get(305),
        interval = cost.get(306)
    ensure(initial >= 0 && max >= initial && interval > 0, 'Arena action point configuration unavailable', 1007)
    const schedule = [
        { at: 0, interval },
        ...String(duel.costTime || '')
            .split('|')
            .filter(Boolean)
            .map((text) => {
                const [at, interval] = text.split('#').map(Number)
                ensure(at >= 0 && interval > 0, 'Invalid arena recovery schedule', 1007)
                return { at, interval }
            }),
    ].sort((a, b) => a.at - b.at)
    const gcd = Number(tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_GCD')?.value)
    ensure(gcd >= 0, 'Arena global cooldown configuration unavailable', 1007)
    return { initial: initial * 100, max: max * 100, schedule, gcd }
}

export function startArenaClock(c) {
    const battle = c.state.combat,
        run = battle.npcDuel,
        timing = arenaTiming(c.tables, run.duel_id)
    if (run.regular_started_at !== undefined) return
    const energy = { points: timing.initial, at: c.now }
    battle.npcDuel = {
        ...run,
        regular_started_at: c.now,
        end_at: c.now + Number(c.tables.find('kibo_duel', run.duel_id).time),
        score_at: c.now,
        energy: { 1: { ...energy }, 2: { ...energy } },
        gcd_until: { 1: 0, 2: 0 },
    }
}

export function advanceArenaScores(c) {
    const battle = c.state.combat,
        run = battle?.npcDuel
    if (!run || run.regular_started_at === undefined || run.result || run.score_at >= c.now) return false
    const counts = { 1: 0, 2: 0 }
    // Membership describes the interval before a summon/death at this instant.
    for (const uuid of Object.keys(run.in_fight)) counts[run.actors[uuid].camp]++
    const empty = counts[1] > 0 && counts[2] === 0 ? 2 : counts[2] > 0 && counts[1] === 0 ? 1 : 0
    const rates = String(
        c.tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_SCORE_VELOCITY')?.value ?? '',
    )
        .split('|')
        .filter(Boolean)
        .map((text) => {
            const [at, rate] = text.split('#').map(Number)
            return { at, rate }
        })
        .sort((a, b) => a.at - b.at)
    ensure(rates.length && rates.every((row) => row.at >= 0 && row.rate >= 0), 'Arena score rate unavailable', 1007)
    let loss = 0
    if (empty)
        for (let i = 0; i < rates.length; i++) {
            const start = Math.max(run.score_at, run.regular_started_at + rates[i].at)
            const end = Math.min(c.now, run.end_at, run.regular_started_at + (rates[i + 1]?.at ?? Infinity))
            if (end > start) loss += (end - start) * rates[i].rate
        }
    const scores = { ...run.scores }
    if (empty) scores[empty] = Math.max(0, scores[empty] - Math.floor(loss))
    battle.npcDuel = { ...run, score_at: Math.min(c.now, run.end_at), scores }
    if (loss)
        c.push('SCProtoKiboDuelArenaScoreInfoSync', {
            score_infos: [1, 2].map((camp) => ({ camp, score: scores[camp] })),
        })
    return loss > 0
}

export function advanceArenaEnergy(c) {
    const battle = c.state.combat,
        run = battle?.npcDuel
    if (!run?.energy || run.result) return false
    const timing = arenaTiming(c.tables, run.duel_id)
    const energy = {}
    let changed = false
    for (const camp of [1, 2]) {
        const previous = run.energy[camp]
        let points = previous.points,
            from = previous.at,
            to = Math.min(c.now, run.end_at)
        for (let i = 0; i < timing.schedule.length; i++) {
            const segment = timing.schedule[i]
            const start = Math.max(from, run.regular_started_at + segment.at)
            const end = Math.min(to, run.regular_started_at + (timing.schedule[i + 1]?.at ?? Infinity))
            if (end > start) points = Math.min(timing.max, points + ((end - start) * 100) / segment.interval)
        }
        energy[camp] = { points, at: Math.max(previous.at, to) }
        if (energy[camp].at !== previous.at || points !== previous.points) changed = true
    }
    if (changed) battle.npcDuel = { ...run, energy }
    return changed
}

export function arenaHand(state) {
    const run = state.combat.npcDuel
    return {
        pet_guids: Object.values(run.actors)
            .filter(
                (actor) => actor.camp === 1 && !run.in_fight[actor.uuid] && state.combat.entities[actor.uuid]?.hp > 0,
            )
            .map((actor) => actor.source_guid),
        global_cd_endtime: String(run.gcd_until?.[1] ?? 0),
    }
}

export function publishArenaEnergy(c) {
    const run = c.state.combat.npcDuel,
        timing = arenaTiming(c.tables, run.duel_id)
    if (!run.energy) return
    const current = Math.floor(run.energy[1].points + 1e-7)
    c.pushBefore('SCProtoKiboDuelArenaActionPointSync', {
        current_points: current,
        max_points: timing.max,
        next_recover_time: '0',
    })
}

export function consumeArenaPoint(c, camp) {
    advanceArenaEnergy(c)
    const battle = c.state.combat,
        run = battle.npcDuel,
        timing = arenaTiming(c.tables, run.duel_id)
    ensure(run.energy?.[camp].points >= 100 - 1e-7, 'Not enough arena action points')
    ensure(c.now * 1000 >= (run.gcd_until?.[camp] ?? 0), 'Arena summon is cooling down')
    battle.npcDuel = {
        ...run,
        energy: { ...run.energy, [camp]: { ...run.energy[camp], points: Math.max(0, run.energy[camp].points - 100) } },
        gcd_until: { ...run.gcd_until, [camp]: c.now * 1000 + timing.gcd },
    }
}
