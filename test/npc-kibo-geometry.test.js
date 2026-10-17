import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { Store } from '../src/store.js'
import { Game } from '../src/game.js'
import { arenaPoint, processNpcArenaQueue } from '../src/npc-kibo-battle.js'
import {
    arenaGeometry,
    arenaPlacementRules,
    arenaSummonPositionAllowed,
    insideArenaRegion,
    wirePositionInArena,
} from '../src/npc-kibo-geometry.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    p = new Protocol(cfg.base)
const rectangle = {
    shape: 'rectangle',
    center: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: 1 },
    radius: 14,
    side_radius: 8,
}
const circle = { ...rectangle, shape: 'circle', radius: 12 }

test('trainer and first-summon headings face the opposite side across every linked NPC scene', () => {
    for (const duel of tables.get('kibo_duel').filter((row) => row.type === 1 && row.id !== 20001)) {
        const map = tables.find('kibo_duel_map', duel.mapId)
        for (const [from, to] of [
            ['nestBorthPos1', 'nestBorthPos2'],
            ['nestBorthPos2', 'nestBorthPos1'],
            ['SummonPos1', 'SummonPos2'],
            ['SummonPos2', 'SummonPos1'],
        ]) {
            const a = arenaPoint(tables, map, from),
                b = arenaPoint(tables, map, to)
            const dx = b.pos.x - a.pos.x,
                dz = b.pos.z - a.pos.z
            const yaw = (a.angle * Math.PI) / 180
            const dot = (Math.sin(yaw) * dx + Math.cos(yaw) * dz) / Math.hypot(dx, dz)
            // Arena headings round to whole degrees; source positions and
            // wire centimeters add a small angular quantization at slants.
            assert.ok(dot > Math.cos((0.6 * Math.PI) / 180), `${duel.id}/${from} must face inward`)
        }
    }
})

test('normal player movement uses hundredths of a degree while arena actor appearance uses whole degrees', () => {
    const map = tables.find('kibo_duel_map', 20008)
    assert.equal(arenaPoint(tables, map, 'nestBorthPos1', 100).angle, 27000)
    assert.equal(arenaPoint(tables, map, 'nestBorthPos2').angle, 90)
    assert.equal(arenaPoint(tables, map, 'SummonPos1').angle, 270)
    assert.equal(arenaPoint(tables, map, 'SummonPos2').angle, 90)
})
// AzurProto.ToServerPos uses float multiplication and conv.i4, not rounding.
const wire = (pos) =>
    Object.fromEntries(
        Object.entries(pos).map(([key, value]) => [key, Math.trunc(Math.fround(Math.fround(value) * 100))]),
    )
function position(area, front, side, height = 0) {
    return {
        x: area.center.x + front * area.forward.x - side * area.forward.z,
        y: area.center.y + height,
        z: area.center.z + front * area.forward.z + side * area.forward.x,
    }
}

test('all valid NPC prefab points agree with table paths and support every configured summon body', () => {
    let count = 0
    const used = new Set()
    for (const duel of tables.get('kibo_duel').filter((row) => row.type === 1 && row.id !== 20001)) {
        const map = tables.find('kibo_duel_map', duel.mapId),
            area = arenaGeometry(tables, duel.id)
        used.add(map.prefabID)
        for (const [field, prefab] of [
            ['nestBorthPos1', 'blue_player'],
            ['nestBorthPos2', 'red_player'],
            ['SummonPos1', 'blue_summon'],
            ['SummonPos2', 'red_summon'],
        ]) {
            const point = arenaPoint(tables, map, field).pos
            for (const key of ['x', 'y', 'z'])
                assert.ok(Math.abs(point[key] / 100 - area.points[prefab][key]) < 0.006, `${duel.id}/${field}/${key}`)
        }
        for (const id of duel.enemy.split('|').filter(Boolean).map(Number)) {
            const rule = arenaPlacementRules(tables, id)
            assert.equal(rule.margin, tables.find('unit', tables.find('pet', id).unitId).colliderParm)
            for (const camp of [1, 2]) {
                const point = arenaPoint(tables, map, camp === 1 ? 'SummonPos1' : 'SummonPos2').pos
                assert.ok(
                    arenaSummonPositionAllowed(tables, duel.id, { config_id: id, camp }, point),
                    `${duel.id}/${id}/${camp}`,
                )
            }
        }
        count++
    }
    assert.equal(count, 217)
    assert.equal(used.size, 4)
    const guide = arenaGeometry(tables, 501)
    assert.equal(
        insideArenaRegion(guide, 1, guide.points.blue_player, 1),
        false,
        'trainer position is outside this deployment area',
    )
    assert.equal(insideArenaRegion(guide, 1, guide.points.blue_summon, 1), true)
    // The prior live v3 sample was map20006/prefab20005.
    const observed = tables.get('kibo_duel').find((row) => row.type === 1 && row.mapId === 20006)
    const live = arenaGeometry(tables, observed.id)
    assert.ok(Math.abs(live.center.x - 131.4) < 0.001)
    assert.ok(Math.abs(live.center.z - 139.5) < 0.001)
    assert.ok(Math.abs(live.forward.z + 1) < 0.001)
})

test('rectangle uses the rotated half-plane and collider margin; circle also uses vertical distance', () => {
    for (const camp of [1, 2]) {
        const sign = camp === 1 ? 1 : -1
        assert.equal(insideArenaRegion(rectangle, camp, position(rectangle, sign * 13, 7, 100), 1), true)
        assert.equal(insideArenaRegion(rectangle, camp, position(rectangle, sign * 13.01, 0), 1), false)
        assert.equal(insideArenaRegion(rectangle, camp, position(rectangle, sign * 2, 7.01), 1), false)
        assert.equal(insideArenaRegion(rectangle, camp, position(rectangle, 0, 0), 1), true)
        assert.equal(insideArenaRegion(rectangle, camp, position(rectangle, -sign, 0), 1), false)
        assert.equal(insideArenaRegion(circle, camp, position(circle, sign * 11, 0), 1), true)
        assert.equal(insideArenaRegion(circle, camp, position(circle, sign * 11, 0, 1), 1), false)
    }
    assert.equal(insideArenaRegion(rectangle, 1, position(rectangle, -2, 0), 1, true), true)
    assert.equal(insideArenaRegion(rectangle, 2, position(rectangle, 2, 0), 1, true), false)
    assert.equal(wirePositionInArena(rectangle, 1, wire(position(rectangle, -2, 0)), 1, true), true)
    assert.equal(wirePositionInArena(rectangle, 2, wire(position(rectangle, 2, 0)), 1, true), false)
    const tagged = {
        find: (name) => (name === 'pet' ? { unitId: 7, kiboDuelTag: '101|0|201' } : { colliderParm: 1.25 }),
    }
    assert.deepEqual(arenaPlacementRules(tagged, 1), { margin: 1.25, global: true })
    assert.equal(wirePositionInArena(rectangle, 1, { x: 0, y: 0, z: 1.2 }), false)
    assert.equal(wirePositionInArena(rectangle, 0, { x: 0, y: 0, z: 1 }), false)
})

test('centimeter truncation preserves valid edges of every rotated prefab without allowing a broad area buffer', () => {
    const duels = tables.get('kibo_duel').filter((row) => row.type === 1)
    const seen = new Set()
    for (const duel of duels) {
        const area = arenaGeometry(tables, duel.id)
        if (seen.has(area)) continue
        seen.add(area)
        for (const camp of [1, 2]) {
            const sign = camp === 1 ? 1 : -1
            for (const front of [0, sign * 3, sign * (area.radius - 1)]) {
                const side = area.shape === 'rectangle' ? area.side_radius - 1 : 0
                const edge = position(area, front, side)
                assert.equal(wirePositionInArena(area, camp, wire(edge), 1), true, `${duel.mapId}/${camp}/${front}`)
            }
            const outside = position(area, sign * (area.radius - 1 + 0.05), 0)
            assert.equal(wirePositionInArena(area, camp, wire(outside), 1), false)
            assert.equal(wirePositionInArena(area, camp, wire(position(area, -sign * 0.05, 0)), 1), false)
            if (area.shape === 'rectangle')
                assert.equal(
                    wirePositionInArena(area, camp, wire(position(area, sign * 3, area.side_radius - 1 + 0.05)), 1),
                    false,
                )
            else
                assert.equal(
                    wirePositionInArena(area, camp, wire(position(area, 0, 0, area.radius - 1 + 0.05)), 1),
                    false,
                )
        }
    }
    const rotated = {
        ...rectangle,
        center: { x: -19.375, y: -2, z: -93.125 },
        forward: { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 },
    }
    // All four quantized corners and the middle line can intersect the source cell.
    for (const front of [0, 13])
        for (const side of [-7, 7]) assert.ok(wirePositionInArena(rotated, 1, wire(position(rotated, front, side)), 1))
    assert.equal(
        wirePositionInArena(circle, 1, { x: 1101, y: 0, z: 0 }, 1),
        false,
        'a degenerate clipped polygon must not imply the origin is inside',
    )
})

test('guide501 scripted coordinate derives from the middle line and summon anchors, not trainer location', () => {
    const area = arenaGeometry(tables, 501),
        [a, b] = area.middle_line
    const tangentLength = Math.hypot(b.x - a.x, b.z - a.z)
    const enemy = area.points.red_summon,
        self = area.points.blue_summon
    const depthLength = Math.hypot(enemy.x - self.x, enemy.z - self.z)
    const point = {
        x: (a.x + b.x) / 2 + ((b.x - a.x) / tangentLength) * 5 + ((enemy.x - self.x) / depthLength) * 3,
        y: area.center.y,
        z: (a.z + b.z) / 2 + ((b.z - a.z) / tangentLength) * 5 + ((enemy.z - self.z) / depthLength) * 3,
    }
    assert.ok(arenaSummonPositionAllowed(tables, 501, { camp: 2, config_id: 500072 }, wire(point)))
})

test('invalid deployment cannot spend points, replace a fighter, or leak state through a rejected protocol', () => {
    let now = 1800000000,
        seq = 1
    const store = new Store(':memory:'),
        game = new Game(p, store, tables, { clock: () => now }),
        session = {}
    const call = (name, request = {}) => {
        const entry = p.byName.get('CSProto' + name)
        return game.dispatch(session, { id: entry.id, seq: seq++, payload: p.encode(entry.req, request) })
    }
    const state = () => store.load(session.id).state
    try {
        call('EnterGame', { open_id: 'npc-geometry' })
        call('KiboDuelGetGroup', { u32: 501 })
        call('MultiCampaignCreate', { dungeon_id: 40007 })
        call('StartDungeonClientOk')
        call('MultiCampaignPlayerLoadFinish')
        call('KiboDuelArenaFirstConfirmReq')
        now = state().combat.npcDuel.intro_until
        game.tick(session.id, session)
        const run = state().combat.npcDuel
        const actor = Object.values(run.actors).find((x) => x.camp === 1 && !run.in_fight[x.uuid])
        const replacement = Object.keys(run.in_fight).find((uuid) => run.actors[uuid].camp === 1)
        const request = {
            pet_guid: actor.uuid,
            source_pet_guid: actor.source_guid,
            replace_kibo_guid: replacement,
            pos: run.positions.enemySummon.pos,
        }
        const before = structuredClone(state().combat),
            writes = store.db.prepare('SELECT total_changes() AS n').get().n
        assert.throws(() => call('KiboDuelArenaSummonReq', request), /outside permitted deployment area/)
        assert.deepEqual(state().combat, before)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        call('KiboDuelArenaSummonReq', { ...request, pos: run.positions.selfSummon.pos })
        assert.ok(state().combat.npcDuel.in_fight[actor.uuid])
        assert.equal(state().combat.npcDuel.in_fight[replacement], undefined)
        assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, writes)
        const enemy = Object.values(run.actors).find((x) => x.camp === 2 && !run.in_fight[x.uuid])
        const queuedState = state(),
            pending = queuedState.combat.npcDuel
        pending.npc_queue = { [enemy.uuid]: { pos: pending.positions.selfSummon.pos } }
        const energy = structuredClone(pending.energy)
        const warnings = []
        const warn = console.warn
        try {
            console.warn = (...args) => warnings.push(args.join(' '))
            processNpcArenaQueue({ state: queuedState, tables, now })
        } finally {
            console.warn = warn
        }
        assert.equal(warnings.length, 1)
        assert.equal(queuedState.combat.npcDuel.npc_queue[enemy.uuid], undefined)
        assert.equal(queuedState.combat.npcDuel.in_fight[enemy.uuid], undefined)
        assert.deepEqual(queuedState.combat.npcDuel.energy, energy)
    } finally {
        store.close()
    }
})
