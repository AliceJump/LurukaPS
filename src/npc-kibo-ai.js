import fs from 'node:fs'
import { consumeArenaPoint } from './npc-kibo-clock.js'
import { setArenaInFight } from './npc-kibo-battle.js'
const rules = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-ai.json', import.meta.url), 'utf8'))

export function advanceNpcArenaAI(c) {
    const battle = c.state.combat,
        run = battle?.npcDuel
    if (
        !run ||
        c.state.multiCampaign?.arena_status !== 4 ||
        run.result ||
        run.ai_control?.[0] === 1 ||
        run.ai_control?.[1] === 1
    )
        return
    if (Object.keys(run.npc_queue ?? {}).length || c.now * 1000 < (run.ai_next_at ?? 0)) return
    const duel = c.tables.find('kibo_duel', run.duel_id)
    if (duel.behaviortree !== rules.source) return
    const active = Object.keys(run.in_fight)
        .map((id) => run.actors[id])
        .filter((actor) => actor.camp === 2)
    let candidates = Object.values(run.actors).filter(
        (actor) => actor.camp === 2 && !run.in_fight[actor.uuid] && battle.entities[actor.uuid]?.hp > 0,
    )
    const next = c.now * 1000 + rules.wait_min_ms + c.randomInt(0, rules.wait_max_ms - rules.wait_min_ms + 1)
    battle.npcDuel = { ...run, ai_next_at: next }
    if (!candidates.length || run.energy[2].points < 100 - 1e-7 || c.now * 1000 < run.gcd_until[2]) return
    let replace
    if (active.length >= duel.KiboNumber) {
        if (run.energy[2].points < rules.replacement_points * 100 - 1e-7) return
        replace = active
            .filter((actor) => battle.entities[actor.uuid].hp / actor.max_hp < rules.replacement_hp_ratio)
            .sort((a, b) => battle.entities[a.uuid].hp / a.max_hp - battle.entities[b.uuid].hp / b.max_hp)[0]
        if (!replace) return
    }
    const unused = candidates.filter((actor) => !run.ever_summoned?.[actor.uuid])
    if (unused.length) candidates = unused
    const counts = new Map()
    for (const id of Object.keys(run.in_fight))
        if (run.actors[id].camp === 1) {
            const element = Number(c.tables.find('pet', run.actors[id].config_id)?.element)
            counts.set(element, (counts.get(element) ?? 0) + 1)
        }
    const dominant = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (dominant !== undefined && rules.element_selection === 2) {
        const score = (actor) => {
            const row = c.tables.find('element_type', Number(c.tables.find('pet', actor.config_id)?.element))
            // Element 0 is a valid neutral element, unlike battle attribute IDs.
            const restraint = new Map(
                String(row?.kiboRestraint ?? '')
                    .split('|')
                    .filter(Boolean)
                    .map((pair) => pair.split('#').map(Number)),
            )
            return restraint.get(dominant) ?? 0
        }
        const best = Math.max(...candidates.map(score))
        candidates = candidates.filter((actor) => score(actor) === best)
    }
    const actor = candidates[c.randomInt(0, candidates.length)]
    consumeArenaPoint(c, 2)
    if (replace) setArenaInFight(c, replace, run.in_fight[replace.uuid].move, false)
    const anchor = run.positions.enemySummon
    const jitter = (amount) => c.randomInt(0, Math.round(amount * 200) + 1) - Math.round(amount * 100)
    c.pushBefore('SCProtoKiboDuelPlaySummonActionStart', { uuid: String(run.npc_id) })
    setArenaInFight(
        c,
        actor,
        {
            pos: {
                ...anchor.pos,
                x: anchor.pos.x + jitter(rules.spawn_offset.x),
                z: anchor.pos.z + jitter(rules.spawn_offset.y),
            },
            angle: anchor.angle,
        },
        true,
    )
}
