import { ErrorCode } from './error-codes.js'
import fs from 'node:fs'
import path from 'node:path'
import { campaignStagePlan } from './campaign-stage-plan.js'
const routeCache = new WeakMap()
// Table-derived compatibility: an exact roster + victory uniquely identifies a
// single common dungeon scene. This is not an official dungeon->scene foreign key.
export function tableWaveCampaignRoute(tables, dungeon) {
    const parts = String(dungeon.victoryCondition).split('#').map(Number)
    if (parts.length !== 5 || parts[0] !== 2500 || parts[2] !== 0 || parts[3] !== 0 || parts[4] <= 0) return null
    const expected = new Map()
    for (const token of String(dungeon.enemy ?? '').split('|')) {
        const [id, count] = token.split('#').map(Number)
        if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(count) || count <= 0) return null
        expected.set(id, (expected.get(id) ?? 0) + count)
    }
    const signature = dungeon.victoryCondition + ':' + JSON.stringify([...expected].sort((a, b) => a[0] - b[0]))
    let cache = routeCache.get(tables)
    if (!cache) routeCache.set(tables, (cache = new Map()))
    if (cache.has(signature)) {
        const saved = cache.get(signature)
        return saved ? { ...saved, dungeon_id: dungeon.id } : null
    }
    const matches = []
    for (const scene of tables.get('dungeon_scene')) {
        if (
            scene.victoryCondition !== dungeon.victoryCondition ||
            tables.find('world_city', scene.id)?.type !== 2 ||
            tables.find('world_blueprint', scene.blueprintId)?.path !==
                'Config/World/Graph/Blueprint/ast_dungeon_ai_common.asset'
        )
            continue
        if (!fs.existsSync(path.join(tables.dir, 'worldmap_' + scene.id + '.json'))) continue
        const rows = tables.get('worldmap_' + scene.id).filter((r) => r.spawnerId === parts[1])
        if (rows.length !== parts[4]) continue
        const actual = new Map()
        let valid = true
        for (const row of rows) {
            const packs = String(tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
                .split('|')
                .filter(Boolean)
            if (!packs.length) valid = false
            for (const pack of packs) {
                const id = tables.find('enemy_pack', Number(pack))?.enemyId
                if (!id) valid = false
                actual.set(id, (actual.get(id) ?? 0) + 1)
            }
        }
        if (!valid || actual.size !== expected.size || [...expected].some(([id, n]) => actual.get(id) !== n)) continue
        const conditions = String(scene.stringParam)
            .split('|')
            .filter((s) => /^finish_con_intlist(?:_\d+)?#/.test(s))
        const end = conditions.findIndex(
            (s) =>
                s
                    .slice(s.indexOf('#') + 1)
                    .split(',')
                    .join('#') === dungeon.victoryCondition,
        )
        if (end < 0 || !tables.get('world_borthpos').some((p) => p.cityId === scene.id && p.mainPoint === 1)) continue
        let plan
        try {
            plan = campaignStagePlan(tables, scene.id)
        } catch (error) {
            if (error.code === ErrorCode.GameConfig) continue
            throw error
        }
        if (plan[end]?.length !== rows.length || !plan[end].every((r) => rows.some((x) => x.id === r.id))) continue
        matches.push({
            dungeon_id: dungeon.id,
            scene_ids: [scene.id],
            mode: 'table_waves',
            victory_stage_count: end + 1,
            source: 'table_inference',
            basis: 'Unique common dungeon scene matching exact victory and complete enemyId/count roster',
            todo: 'Verify scene selection against official CBT3 route; table matching is a local compatibility inference',
        })
    }
    const route = matches.length === 1 ? matches[0] : null
    cache.set(signature, route)
    return route
}
export function storyCampaignStagePlan(tables, run) {
    const plan = campaignStagePlan(tables, run.map_id)
    return run.victory_stage_count ? plan.slice(0, run.victory_stage_count) : plan
}
