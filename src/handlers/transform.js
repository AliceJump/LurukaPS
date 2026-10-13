import { ensure } from './common.js'
import { activeFormationManager, temporaryHeroes } from '../trial-actors.js'
import { combatState } from '../combat-state.js'
import { clearSceneMount } from '../mounts.js'

function retire(state) {
    const old = state.world.transform
    if (!old) return
    const battle = state.combat
    if (battle) {
        delete battle.skills[old.guid]
        if (battle.entities[old.guid])
            battle.entities[old.guid] = { ...battle.entities[old.guid], hp: 0, alive_state: 1 }
    }
    delete state.world.transform
}

export function registerTransform(on, tables, store) {
    on('TransformStart', (c, r) => {
        const enemy = tables.find('enemy', r.tran_id)
        ensure(enemy && enemy.isUsable === 1 && enemy.unitId > 0, 'Invalid transform enemy')
        const manager = activeFormationManager(c.state)
        const formation = manager?.groups.find((g) => g.id === manager.cur_group)
        ensure(formation, 'No active transform formation')
        const member = formation.heros.find((h) => h.hero_id === formation.control) ?? formation.heros[0]
        const hero = [...c.state.player.heros_info.heros, ...temporaryHeroes(c.state)].find(
            (h) => h.guid === member?.hero_id,
        )
        ensure(hero, 'No active transform owner')
        let transform = c.state.world.transform
        if (!transform || transform.config_id !== enemy.id || transform.owner_id !== hero.guid) {
            retire(c.state)
            const sequence = store.nextSequence('transform-actor')
            ensure(sequence < 0x400000, 'Transform identity exhausted')
            // Local compatibility namespace, distinct from automatic summons
            // (>=0x800000). Official transform GUID layout remains unverified.
            const guid = ((17n << 56n) | (BigInt(0x400000 + sequence) << 32n) | BigInt(c.id)).toString()
            const info = c.state.player.heros_info.battle_infos.find((h) => h.hero_id === hero.guid)
            ensure(info && Number.isSafeInteger(info.hp) && info.hp >= 0, 'Transform owner battle info unavailable')
            ensure(Number.isInteger(hero.hero_lv) && hero.hero_lv > 0, 'Transform owner level unavailable')
            transform = { guid, config_id: enemy.id, owner_id: hero.guid, level: hero.hero_lv, hp: info.hp }
            c.state.world.transform = transform
        }
        clearSceneMount(c.state)
        const battle = combatState(c.state, c.now)
        battle.entities[transform.guid] ??= {
            uuid: transform.guid,
            owner_id: transform.owner_id,
            hp: transform.hp,
            sp: 0,
            alive_state: 0,
            transformed: true,
            updated_at: c.now,
        }
        // CBT3 OnSyncKiBoTransform consumes these three fields and dispatches
        // the normal controllable-entity creation flow before the null ACK.
        c.pushBefore('CSProtoTransformSync', {
            cur_tran_id: transform.config_id,
            cur_level: transform.level,
            detail_data: { hero_id: transform.guid, hp: transform.hp, sp: 0, alive_state: 0 },
        })
        return {}
    })
    on('TransformEnd', (c) => {
        retire(c.state)
        c.pushBefore('CSProtoTransformSync', { cur_tran_id: 0 })
        return {}
    })
}
