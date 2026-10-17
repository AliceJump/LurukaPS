import { ErrorCode } from '../error-codes.js'
import { taskEnemyGroups } from '../task-enemy-groups.js'
import { ensure } from './common.js'
import { enemyDefinition } from '../enemy-state.js'
import { combatState } from '../combat-state.js'
import { WorldObjectCatalog } from '../world-objects.js'

export function syncAIHeroBeforeCreate(c, uuid) {
    const definition = enemyDefinition(c.tables, c.state, uuid)
    ensure(definition, 'AI hero attributes unavailable', ErrorCode.NoEnemyConf)
    ensure(
        c.tables.find('enemy_pack', definition.pack_id)?.specialCreateType === 1,
        'Combat actor is not an AI hero',
        ErrorCode.InvalidTarget,
    )
    const battle = combatState(c.state, c.now)
    const entity = (battle.entities[uuid] ??= {
        uuid,
        ...definition,
        hp: definition.max_hp,
        sp: 0,
        alive_state: 0,
        updated_at: c.now,
    })
    // EnemyUnit reads EntityService's sync block during creation; the UUID
    // alone supplies no current HP. Send the block before releasing its waiter.
    c.pushBefore('CSProtoObjBattleInfoSync', {
        infos: [{ uuid, hp: entity.hp, sp: entity.sp ?? 0, alive_state: entity.alive_state ?? 0, reason: 1 }],
    })
}

export function registerAIHeroes(on, tables) {
    const world = new WorldObjectCatalog(tables)
    on('CSWorldObjAIHeroInfo', (c, r) => {
        const pack = tables.find('enemy_pack', r.enemy_pack_id)
        ensure(pack?.specialCreateType === 1 && tables.find('hero', pack.enemyId), 'Unknown AI hero pack')
        // Playable groups receive kind7 UUIDs in WorldObjEnemyInfo. Reuse that
        // exact actor identity, including for friendly heroes in those groups.
        for (const [key, entry] of Object.entries(c.state.playableEnemies ?? {})) {
            const [mapId, , playId] = key.split(':').map(Number)
            const run = c.state.playableRuns?.[playId]
            if (mapId !== c.state.world.map_id || run?.map_id !== mapId || ![1, 2].includes(run.status)) continue
            const entity = entry.entities.find((entity) => entity.config_id === pack.id)
            if (entity && enemyDefinition(tables, c.state, entity.uuid)?.pack_id === pack.id) {
                syncAIHeroBeforeCreate(c, entity.uuid)
                return { enemy_pack_id: pack.id, uuid: entity.uuid }
            }
        }
        for (const entry of taskEnemyGroups(tables, c.state)) {
            const slots = String(tables.find('world_enemy_group', entry.groupId)?.enemyList ?? '')
                .split('|')
                .map(Number)
            const slot = slots.indexOf(pack.id)
            if (slot < 0) continue
            // Same task-container UUID layout as other units in this group.
            // The client builds the AI hero's skills/attributes from enemy_pack.
            // Keep it separate from the player's owned hero and formation.
            const uuid = ((4n << 56n) | (BigInt(slot) << 32n) | BigInt(entry.objectId)).toString()
            syncAIHeroBeforeCreate(c, uuid)
            return { enemy_pack_id: pack.id, uuid }
        }
        // Fixed scene groups (e.g. Miti in dungeon10071/map6207) already have
        // kind3 actors in WorldMapSync. Reuse their identity instead of minting
        // a second friendly hero or changing the player's trial formation.
        for (const [key, record] of Object.entries(c.state.worldObjects ?? {})) {
            if (!key.startsWith(c.state.world.map_id + ':') || record.active !== true || record.complete) continue
            const group = record.expand_data?.battle_group
            const entity = group?.monsters?.find((entry) => entry.enemy_pack === pack.id)
            if (!entity) continue
            const { row, spawner } = world.object(c.state.world.map_id, record.obj_id)
            if (spawner.objectType !== 50) continue
            const slot = entity.obj_key?.obj_index ?? 0
            if (group.world_indexes && !group.world_indexes.includes(slot)) continue
            const configured = String(tables.find('world_enemy_group', row.expandId)?.enemyList ?? '')
                .split('|')
                .map(Number)
            const uuid = ((3n << 56n) | (BigInt(slot) << 32n) | BigInt(row.id)).toString()
            if (
                configured[slot] !== pack.id ||
                entity.uid !== uuid ||
                enemyDefinition(tables, c.state, uuid)?.pack_id !== pack.id
            )
                continue
            syncAIHeroBeforeCreate(c, uuid)
            return { enemy_pack_id: pack.id, uuid }
        }
        ensure(false, 'AI hero is not configured in the active task scene or playable')
    })
}
