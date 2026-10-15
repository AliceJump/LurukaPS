import { arenaContext } from './npc-kibo-time.js'
import { ARENA_TICK_HZ } from './npc-kibo-time.js'
import { advanceNpcArenaAI } from './npc-kibo-ai.js'
import { advanceArenaEnergy, advanceArenaScores, arenaHand, publishArenaEnergy } from './npc-kibo-clock.js'
import { startNpcArenaRound, finishNpcArenaPresentation, processNpcArenaQueue } from './npc-kibo-battle.js'
import { npcArenaOutcome, settleNpcArena } from './npc-kibo-result.js'
import { advanceArenaPetAI } from './npc-kibo-pet-ai.js'
import { publishArenaStatistics } from './npc-kibo-statistics.js'
import { advanceArenaSp, publishArenaSp } from './npc-kibo-sp.js'
import { updateNpcArenaPause } from './npc-kibo-pause.js'
import { advanceArenaControls } from './npc-kibo-controls.js'

export function npcArenaTickDue(state, now) {
    const run = state.combat?.npcDuel,
        phase = state.multiCampaign?.arena_status
    if (!run || run.map_id !== state.world.map_id) return false
    if (run.pause) return false
    const ready = run.entities_sent !== false && state.kiboDuelLoadingCompleteAt !== undefined
    return (
        (phase === 4 &&
            ((ready && Math.floor((run.last_tick ?? -1) * ARENA_TICK_HZ) < Math.floor(now * ARENA_TICK_HZ)) ||
                !!npcArenaOutcome(state, now))) ||
        (phase === 3 &&
            !!state.kiboDuelLoadingCompleteAt &&
            run.entities_sent &&
            run.first_until !== undefined &&
            now >= run.first_until) ||
        (phase === 6 && state.kiboDuelLoadingCompleteAt !== undefined && run.entities_sent && now >= run.intro_until) ||
        (phase === 5 && run.exit_at !== undefined && now >= run.exit_at)
    )
}

export function forkNpcArenaRuntime(base) {
    return {
        ...base,
        multiCampaign: { ...base.multiCampaign },
        combat: {
            ...base.combat,
            bullets: { ...base.combat.bullets },
            entities: { ...base.combat.entities },
        },
    }
}

export function tickNpcArena(c) {
    c = arenaContext(c)
    let run = c.state.combat.npcDuel
    if (run.pause) return
    if (c.state.multiCampaign.arena_status === 3 && c.now >= run.first_until) startNpcArenaRound(c)
    if (c.state.multiCampaign.arena_status === 6 && c.now >= c.state.combat.npcDuel.intro_until) {
        finishNpcArenaPresentation(c)
        if (c.state.world.pause?.operate) updateNpcArenaPause(c, c.state.world.pause)
        return
    }
    if (c.state.multiCampaign.arena_status === 4) {
        advanceArenaScores(c)
        publishArenaStatistics(c)
        if (npcArenaOutcome(c.state, c.now)) {
            settleNpcArena(c)
            return
        }
        advanceArenaEnergy(c)
        advanceArenaControls(c)
        processNpcArenaQueue(c)
        advanceNpcArenaAI(c)
        advanceArenaSp(c)
        advanceArenaPetAI(c)
        publishArenaSp(c)
        publishArenaEnergy(c, false)
        const hand = arenaHand(c.state),
            marker = JSON.stringify(hand)
        if (c.state.combat.npcDuel.hand_sent !== marker) {
            c.pushBefore('SCProtoKiboDuelArenaCardInfoSync', hand)
            c.state.combat.npcDuel = { ...c.state.combat.npcDuel, hand_sent: marker }
        }
        c.state.combat.npcDuel = { ...c.state.combat.npcDuel, last_tick: c.now }
    }
    run = c.state.combat.npcDuel
    if (c.state.multiCampaign.arena_status === 5 && c.now >= run.exit_at) {
        c.state.multiCampaign.arena_status = 7
        c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
            status: 7,
            status_endtime: String(Math.ceil(c.now)),
            enter_type: 0,
        })
    }
}
