import { ErrorCode } from './error-codes.js'
import { arenaContext } from './npc-kibo-time.js'
import fs from 'node:fs'
import { ensure } from './handlers/common.js'

const config = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-presentation.json', import.meta.url), 'utf8'))

export function npcArenaPresentation(tables, duelId) {
    const duel = tables.find('kibo_duel', duelId)
    const map = tables.find('kibo_duel_map', duel.mapId)
    const storyId = Number(map.KiboEnterStoryID)
    const story = tables.find('story', storyId),
        timing = config.stories[storyId]
    ensure(
        story && timing && timing.timeline_seconds > 0,
        'Arena entry presentation configuration unavailable',
        ErrorCode.GameConfig,
    )
    // The server controls the FIRST story window. The extracted Timeline also
    // contains a long held final camera shot; its container length is not the
    // stage duration. StoryStage.OnExit handles ending that presentation.
    // Keep the extracted asset metadata as evidence, not as an extra timer.
    const seconds = Number(tables.get('game').find((row) => row.title === 'KIBO_DUEL_ARENA_MODE_FIRST_TIME')?.value)
    ensure(
        Number.isInteger(seconds) && seconds > timing.client_delay_seconds,
        'Arena entry stage duration configuration unavailable',
        ErrorCode.GameConfig,
    )
    return { storyId, seconds }
}

export function publishNpcArenaPresentation(c) {
    c = arenaContext(c)
    const run = c.state.combat.npcDuel
    c.pushBefore('SCProtoKiboDuelArenaStingerInfoSync', { stage: 2, end_time: String(Math.ceil(run.intro_until)) })
    c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
        status: 6,
        status_endtime: String(Math.ceil(run.intro_until)),
        enter_type: 0,
    })
}

export function beginNpcArenaPresentation(c, replay = false) {
    c = arenaContext(c)
    const run = c.state.combat.npcDuel
    const { storyId, seconds } = npcArenaPresentation(c.tables, run.duel_id)
    if (replay)
        c.pushBefore('SCProtoKiboDuelArenaInfoSync', {
            status: 3,
            status_endtime: String(Math.ceil(c.now)),
            enter_type: 0,
        })
    c.state.combat.npcDuel = { ...run, intro_story_id: storyId, intro_started_at: c.now, intro_until: c.now + seconds }
    c.state.multiCampaign.arena_status = 6
    c.pushBefore('SCProtoKiboDuelArenaFirstConfirmInfoSync', {
        confirm_infos: [
            { player_id: c.id, isConfirm: true },
            { player_id: run.npc_id, isConfirm: true },
        ],
    })
    publishNpcArenaPresentation(c)
}
