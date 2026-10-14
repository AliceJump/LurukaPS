import fs from 'node:fs'
import { ensure } from './handlers/common.js'

const config = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-presentation.json', import.meta.url), 'utf8'))

export function npcArenaPresentation(tables, duelId) {
    const duel = tables.find('kibo_duel', duelId)
    const map = tables.find('kibo_duel_map', duel.mapId)
    const storyId = Number(map.KiboEnterStoryID)
    const story = tables.find('story', storyId),
        timing = config.stories[storyId]
    ensure(story && timing && timing.timeline_seconds > 0, 'Arena entry presentation configuration unavailable', 1007)
    // Wall-clock deadline follows the client's4s start timer, master Timeline
    // length, and the story table's closing mask. Exact official scheduling
    // is not captured; this local envelope must not shorten those actions.
    const seconds = Math.ceil(
        timing.client_delay_seconds + timing.timeline_seconds + Number(story.endCover || 0) / 1000,
    )
    return { storyId, seconds }
}

export function publishNpcArenaPresentation(c) {
    const run = c.state.combat.npcDuel
    c.pushBefore('SCProtoKiboDuelArenaStingerInfoSync', { stage: 2, end_time: String(run.intro_until) })
    c.pushBefore('SCProtoKiboDuelArenaInfoSync', { status: 6, status_endtime: String(run.intro_until), enter_type: 0 })
}

export function beginNpcArenaPresentation(c, replay = false) {
    const run = c.state.combat.npcDuel
    const { storyId, seconds } = npcArenaPresentation(c.tables, run.duel_id)
    if (replay)
        c.pushBefore('SCProtoKiboDuelArenaInfoSync', { status: 3, status_endtime: String(c.now), enter_type: 0 })
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
