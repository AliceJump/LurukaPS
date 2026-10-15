import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { initializeNpcDuelBattle } from '../src/npc-kibo-battle.js'
import { arenaPetAttributes } from '../src/kibo-arena-attributes.js'
import {
    arenaBaseProperties,
    arenaProperty,
    captureArenaProperties,
    mergeArenaProperties,
} from '../src/npc-kibo-properties.js'
import { evaluateArenaFormula } from '../src/npc-kibo-formulas.js'
import { enemyDefinition } from '../src/enemy-state.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
const entry = (attr_id, attr_val) => ({ attr_id, attr_val: String(attr_val) })
const change = (attrId, type, value, tag = 0) => ({ attrId, attr_values: [{ attr_type: type, value, attr_tag: tag }] })
function context(attrs) {
    const state = {
        player: { basic_info: { id: 1 } },
        world: { map_id: 1052 },
        multiCampaign: { duel_id: 501, map_id: 1052, start_time: 100, arena_status: 4 },
    }
    const data = arenaPetAttributes(tables, 500097, 1)
    if (attrs) data.attrs = { attrs }
    const run = initializeNpcDuelBattle(
        tables,
        state,
        {
            hero_info: { hero_guid: '123' },
            infos: [{ pet_guid: { guid: '456' }, pet_conf_id: 500097, pet_lv: 1, ...data }],
        },
        100,
    )
    const actor = Object.values(run.actors).find((actor) => actor.camp === 1)
    return {
        state,
        tables,
        actor,
        set: (rows) => mergeArenaProperties({ state, tables }, { uuid: actor.uuid, attrButeInfos: rows }),
    }
}

test('wire conversion follows the six native scaled IDs, float conversion, group aliases and HP truncation', () => {
    const attrs = arenaBaseProperties(tables, {
        attrs: [
            entry(1, 2_000_000),
            entry(1001, 2500),
            entry(2001, 10),
            entry(5, 10_009_999),
            entry(7, 1000),
            entry(8, 15000),
            entry(35, 80000),
            entry(201, 50_760_000),
            entry(229, 10000),
        ],
    })
    assert.deepEqual(attrs[1], { base: 200, percent: 0.25, extra: 10 })
    assert.equal(attrs[5].base, 1000)
    assert.equal(attrs[7].base, 1000, 'CRI remains in the random-roll comparison scale')
    assert.equal(attrs[8].base, 15000)
    assert.equal(attrs[35].base, 80000, 'SPEED uses its table ratio at read time, not at wire decode')
    assert.equal(attrs[201].base, 5076)
    assert.equal(attrs[229].base, 1)
    const f = context([
        entry(1, 2_000_000),
        entry(1001, 2500),
        entry(2001, 10),
        entry(5, 10_000_000),
        entry(6, 999999),
        entry(7, 1000),
        entry(35, 80000),
    ])
    assert.equal(arenaProperty(f, f.actor.uuid, 1), 260)
    assert.equal(arenaProperty(f, f.actor.uuid, 7), 1000)
    assert.equal(arenaProperty(f, f.actor.uuid, 35), 8)
    assert.notEqual(arenaProperty(f, f.actor.uuid, 6), 999999, 'SP initialization overrides wire MAXSP')
    const hp = context([entry(5, 10_009_999), entry(1005, 2500), entry(2005, 10)])
    assert.equal(
        hp.actor.max_hp,
        1260,
        'initial HP includes the same native external percent/extra components as later caps',
    )
    assert.equal(hp.state.combat.entities[hp.actor.uuid].hp, 1260)
})

test('all configured dynamic attributes retain partial components, conditional tag order and native selectors', () => {
    const f = context([entry(1, 2_000_000), entry(1001, 2500), entry(2001, 10), entry(5, 10_000_000)])
    const id = f.actor.uuid
    f.set([change(1, 3, 20), change(1, 5, 0.5), change(1, 4, 10), change(1, 4, 50, 9), change(7, 4, 500)])
    assert.equal(arenaProperty(f, id, 1), 430)
    assert.equal(arenaProperty(f, id, 1, undefined, false, [9]), 480)
    assert.equal(
        arenaProperty(f, id, 1, undefined, false, [0, 9, 9]),
        530,
        'native tag traversal does not deduplicate the list',
    )
    assert.deepEqual(
        [1, 2, 3, 4, 5, 6].map((component) => arenaProperty(f, id, 1, undefined, false, [9], component)),
        [200, 10, 0.25, 260, 10, 0.5],
    )
    f.set([change(1, 6, 25, 9)])
    assert.equal(arenaProperty(f, id, 1), 25)
    assert.equal(arenaProperty(f, id, 1, undefined, false, null, 4), 260, 'raw component reads bypass force')
    f.set([change(1, 6, -100000), change(1, 4, 0)])
    assert.equal(arenaProperty(f, id, 1), 420)
    assert.equal(f.state.combat.entities[id].arena_properties[7]['4:0'], 500)
    f.set([change(1, 3, -1000), change(1, 5, 0)])
    assert.equal(arenaProperty(f, id, 1), 0, 'native table minimum clamps final ATK')
})

test('captured base/dynamic state survives later reports and feeds actual serialized attack formulas', () => {
    const f = context([entry(1, 2_000_000), entry(5, 10_000_000)]),
        id = f.actor.uuid
    f.set([change(1, 4, 50)])
    const snapshot = captureArenaProperties(f, id)
    f.set([change(1, 4, 100)])
    const calculate = (saved) =>
        evaluateArenaFormula(4, {
            entity: (item) => {
                assert.equal(item.target, 3)
                return arenaProperty(f, id, item.operation, undefined, false, null, item.custom_int, saved)
            },
            parameter: () => 5000,
        })
    assert.equal(calculate(snapshot), 125)
    assert.equal(calculate(null), 150)
    snapshot.arena_properties[1]['4:0'] = 999
    assert.equal(arenaProperty(f, id, 1), 300, 'snapshot callers cannot modify live nested state')
    const draft = { ...f, state: { ...f.state, combat: { ...f.state.combat } } }
    const before = structuredClone(f.state)
    assert.throws(
        () => mergeArenaProperties(draft, { uuid: id, attrButeInfos: [change(1, 4, 5), change(3, 4, Infinity)] }),
        /Invalid arena property/,
    )
    assert.deepEqual(f.state, before)
})

test('MAXHP definitions use current effects, and old runs keep their recorded cap until base evidence is available', () => {
    const f = context(),
        id = f.actor.uuid,
        base = f.actor.max_hp
    f.set([change(5, 6, base + 500)])
    assert.equal(enemyDefinition(tables, f.state, id).max_hp, base + 500)
    const old = structuredClone(f.state)
    delete old.combat.npcDuel.actors[id].base_properties
    assert.equal(enemyDefinition(tables, old, id).max_hp, base)
    assert.throws(() => arenaProperty({ tables, state: old }, id, 1), /base properties unavailable/)
})

test('real attribute/heal packets respect buffed MAXHP, rollback together and remain deferred in SQLite', () => {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now }),
        session = {}
    const call = (name, data = {}) => {
        const proto = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: proto.id, seq: seq++, payload: p.encode(proto.req, data) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-all-properties' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('MultiCampaignPlayerLoaded')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        const actor = Object.values(state().combat.npcDuel.actors).find(
            (actor) => actor.camp === 1 && state().combat.npcDuel.in_fight[actor.uuid],
        )
        const request = {
            base_time: String(now * 1000),
            uint64_dic: [actor.uuid],
            battle_info: [
                {
                    attr_change: {
                        uuid: actor.uuid,
                        attrButeInfos: [change(5, 6, actor.max_hp + 500), change(1, 4, 20)],
                    },
                },
                { hurt_info: { from_id: '1', tar_id: '1', hp_change: 100000 } },
            ],
        }
        const before = state(),
            writes = store.db.prepare('SELECT total_changes() AS n').get().n,
            original = game.packet
        game.packet = function (name, ...args) {
            if (name === 'CSProtoObjBattleInfoSync') throw Error('property HP fault')
            return original.call(this, name, ...args)
        }
        assert.throws(() => call('BattleInfoReduce', request), /property HP fault/)
        game.packet = original
        assert.deepEqual(state(), before)
        call('BattleInfoReduce', request)
        assert.equal(state().combat.entities[actor.uuid].arena_properties[5]['6:0'], actor.max_hp + 500)
        assert.equal(enemyDefinition(tables, state(), actor.uuid).max_hp, actor.max_hp + 500)
        assert.equal(state().combat.entities[actor.uuid].hp, actor.max_hp + 500)
        assert.equal(state().combat.entities[actor.uuid].arena_properties[1]['4:0'], 20)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
    } finally {
        store.close()
    }
})
