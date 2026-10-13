import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { isPlayerDamageSource } from '../src/damage-owner.js'
import { beginSceneTransition } from '../src/scene-transition.js'

test('logged transform310095 syncs before ACK, supports skills and restores the unchanged formation', () => {
    const cfg = configuration(),
        tables = new Tables(cfg.tables),
        p = new Protocol(cfg.base)
    const store = new Store(':memory:'),
        game = new Game(p, store, tables),
        session = {}
    let seq = 1
    const call = (name, request = {}) => {
        const e = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: e.id, seq: seq++, payload: p.encode(e.req, request) })
    }
    try {
        call('EnterGame', { open_id: 'transform-test' })
        store.transact(session.id, 0, (s) => {
            const hero = s.player.heros_info.heros[0]
            const g = s.player.group_mgrs.find((m) => m.type === 1).groups[0]
            g.heros = [{ hero_id: hero.guid, pet_id: '0' }]
            g.control = hero.guid
        })
        const formation = structuredClone(store.load(session.id).state.player.group_mgrs)
        const packets = call('TransformStart', { tran_id: 310095 })
        assert.equal(packets[0].id, 10790)
        assert.equal(packets.at(-1).id, 10791)
        const data = p.decode('CSTransformSync', packets[0].payload)
        assert.equal(data.cur_tran_id, 310095)
        assert.ok(data.cur_level > 0)
        const guid = data.detail_data.hero_id
        assert.ok(isPlayerDamageSource(store.load(session.id).state, guid))
        call('TransformStart', { tran_id: 310095 })
        assert.equal(store.load(session.id).state.world.transform.guid, guid)
        call('SkillStart', { unit_id: guid, skill: { skill_id: 31009502 }, op_time: '0' })
        call('SkillStop', { unit_id: guid, skill_id: '31009502', op_time: '0' })
        const ended = call('TransformEnd')
        assert.equal(p.decode('CSTransformSync', ended[0].payload).cur_tran_id, 0)
        assert.equal(store.load(session.id).state.world.transform, undefined)
        assert.deepEqual(store.load(session.id).state.player.group_mgrs, formation)
        call('TransformEnd')
        assert.throws(() => call('TransformStart', { tran_id: 4294967295 }), /Invalid transform enemy/)
        const other = tables.get('enemy').find((e) => e.id !== 310095 && e.isUsable === 1 && e.unitId > 0)
        call('TransformStart', { tran_id: other.id })
        assert.equal(store.load(session.id).state.world.transform.config_id, other.id)
        const state = store.load(session.id).state
        const transitioned = structuredClone(state)
        transitioned.world.map_id = state.world.map_id + 1
        beginSceneTransition(transitioned, state.world.map_id, 1800000000, 256)
        assert.equal(transitioned.world.transform, undefined)
        const login = p.byName.get('CSProtoEnterGame')
        game.dispatch(
            {},
            { id: login.id, seq: 1, payload: p.encode(login.req, { open_id: 'transform-test', reconnect: true }) },
        )
        assert.equal(store.load(session.id).state.world.transform, undefined)
    } finally {
        store.close()
    }
})
