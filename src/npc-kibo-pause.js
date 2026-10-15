import { arenaContext, arenaMillis, secondsToArenaMs } from './npc-kibo-time.js'
import { advanceArenaEnergy, advanceArenaScores, publishArenaEnergy, arenaHand } from './npc-kibo-clock.js'
import { advanceArenaSp, publishArenaSp } from './npc-kibo-sp.js'
import { stopArenaPetAI } from './npc-kibo-pet-ai.js'
import { npcArenaOutcome, settleNpcArena } from './npc-kibo-result.js'

const shifted = (value, delta) => (Number.isFinite(value) ? value + delta : value)
const deadline = (value, delta) => (value ? shifted(value, delta) : value)
const map = (entries, fn) => Object.fromEntries(Object.entries(entries ?? {}).map(([key, value]) => [key, fn(value)]))

// Called before world.pause is replaced so the last active interval is settled
// under the previous state. Identity/start_time and real protocol timestamps
// never shift; only gameplay clocks and deadlines do.
export function updateNpcArenaPause(c, request) {
    c = arenaContext(c)
    let run = c.state.combat?.npcDuel
    const phase = c.state.multiCampaign?.arena_status
    // First selection and active battle have verified server-pause UI paths.
    // Entry-movie/exit-stage timers need their own elapse-slot audit.
    if (!run || run.map_id !== c.state.world.map_id || run.result || ![3, 4].includes(phase)) return false
    const clientTime = String(request.game_time ?? '0'),
        previous = c.state.world.pause
    if (
        previous &&
        clientTime !== '0' &&
        previous.game_time !== '0' &&
        (BigInt(clientTime) < BigInt(previous.game_time ?? '0') ||
            (clientTime === previous.game_time && !!request.operate !== previous.operate))
    )
        return true
    // A repeated state notification only advances the client watermark. It
    // must not reset world.pause.updated_at and erase an active SP interval.
    if (previous && !!request.operate === previous.operate && (request.operate ? !!run.pause : !run.pause)) {
        c.state.world.pause = { ...previous, game_time: clientTime }
        return true
    }
    if (request.operate) {
        if (!run.pause) {
            advanceArenaScores(c)
            if (phase === 4 && npcArenaOutcome(c.state, c.now)) {
                settleNpcArena(c)
                return false
            }
            advanceArenaEnergy(c)
            advanceArenaSp(c)
            stopArenaPetAI(c)
            run = c.state.combat.npcDuel
            c.state.combat.npcDuel = { ...run, pause: { server_at: c.now, client_at_ms: clientTime } }
            publishArenaEnergy(c)
            publishArenaSp(c)
        }
        return false
    }
    if (!run.pause) return false
    const pause = run.pause,
        ms = Math.max(0, arenaMillis(c) - secondsToArenaMs(pause.server_at)),
        delta = ms / 1000
    const { pause: ignored, ...rest } = run
    const resumed = {
        ...rest,
        energy: run.energy ? map(run.energy, (value) => ({ ...value, at: shifted(value.at, delta) })) : undefined,
        gcd_until: map(run.gcd_until, (value) => deadline(value, ms)),
        ai_next_at: deadline(run.ai_next_at, ms),
        pet_ai: map(run.pet_ai, (value) => ({
            ...value,
            moving: false,
            ready_at: shifted(value.ready_at, ms),
            gcd_until: deadline(value.gcd_until, ms),
            cooldowns: map(value.cooldowns, (value) => deadline(value, ms)),
            groups: map(value.groups, (value) => deadline(value, ms)),
        })),
        pet_sp: map(run.pet_sp, (value) => ({
            ...value,
            at: shifted(value.at, ms),
            lock_until: deadline(value.lock_until, ms),
        })),
        in_fight: map(run.in_fight, (value) => ({
            ...value,
            entered_report_at: value.entered_report_at ?? value.entered_at,
            entered_at: shifted(value.entered_at, delta),
        })),
        trainer_skills: map(run.trainer_skills, (value) => ({ ...value, ready_at: shifted(value.ready_at, ms) })),
        trainer_effects: (run.trainer_effects ?? []).map((value) => ({ ...value, at_ms: value.at_ms + ms })),
        controls: map(run.controls, (value) => ({
            ...value,
            expires_ms:
                value.expires_ms === null ? null : (BigInt(value.expires_ms) + BigInt(Math.round(ms))).toString(),
        })),
        trainer_casts: (run.trainer_casts ?? []).map((value) => {
            if (value.stopped || !value.client_at_ms || value.client_at_ms === '0' || pause.client_at_ms === '0')
                return value
            const end = BigInt(clientTime),
                start = BigInt(value.client_at_ms),
                paused = BigInt(pause.client_at_ms)
            const begin = start > paused ? start : paused,
                overlap = end > begin ? end - begin : 0n
            return { ...value, paused_client_ms: (BigInt(value.paused_client_ms ?? '0') + overlap).toString() }
        }),
        last_tick: undefined,
    }
    for (const key of phase === 3 ? ['first_until'] : ['regular_started_at', 'end_at', 'score_at'])
        if (run[key] !== undefined) resumed[key] = shifted(run[key], delta)
    c.state.combat.npcDuel = resumed
    const until = phase === 3 ? resumed.first_until : resumed.end_at
    c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
        status: phase,
        status_endtime: String(Math.ceil(until)),
        enter_type: 0,
    })
    publishArenaEnergy(c)
    publishArenaSp(c)
    c.pushBefore('SCProtoKiboDuelArenaCardInfoSync', arenaHand(c.state))
    return false
}
