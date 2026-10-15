import test from 'node:test'
import assert from 'node:assert/strict'
import { configuration } from '../src/config.js'
import { Tables } from '../src/player.js'
import { Protocol } from '../src/protocol.js'
import { startArenaClock, advanceArenaEnergy, publishArenaEnergy, consumeArenaPoint } from '../src/npc-kibo-clock.js'

const cfg = configuration(),
    tables = new Tables(cfg.tables),
    protocol = new Protocol(cfg.base)
function context() {
    const packets = [],
        c = {
            state: { world: { map_id: 1052 }, combat: { npcDuel: { duel_id: 1002, map_id: 1052 } } },
            tables,
            now: 100,
            pushBefore(name, data) {
                const e = protocol.byName.get(name)
                packets.push({ at: c.now * 1000, ...protocol.decode(e.rsp, protocol.encode(e.rsp, data)) })
            },
        }
    startArenaClock(c)
    return { c, packets }
}

// CBT3 ModuleDuelEnergy.OnRefreshCost/PlayCostTransition: each changed float
// removes CostInit and schedules it again after0.35s. That callback updates
// the count image and each Filled flag. This models that callback only, not
// the rest of the Unity UI or its per-frame continuous fill animation.
function energyView(packets, end, mainUIResets = []) {
    let last = 0,
        pending
    const counts = [],
        filled = [false, false, false]
    const advance = (now) => {
        if (pending && pending.at <= now) {
            if (counts.at(-1) !== pending.value) counts.push(pending.value)
            for (let i = 0; i < filled.length; i++) filled[i] = i < pending.value
            pending = undefined
        }
    }
    const events = [
        ...packets.map((packet) => ({ at: packet.at, packet })),
        ...mainUIResets.map((at) => ({ at })),
    ].sort((a, b) => a.at - b.at)
    for (const event of events) {
        advance(event.at)
        if (!event.packet) {
            filled.fill(false)
            continue
        } // OnMainUIShow resets Filled, not m_lastCost.
        const cost = Math.fround(event.packet.current_points / 100)
        if (cost !== last) {
            pending = { at: event.at + 350, value: Math.trunc(cost) }
            last = Math.trunc(cost)
        }
    }
    advance(end)
    return { counts, filled }
}

test('passive action-point sync lets the native count callback complete through1/3,2/3,3/3', () => {
    const { c, packets } = context()
    for (let ms = 0; ms <= 30000; ms += 10) {
        c.now = 100 + ms / 1000
        advanceArenaEnergy(c)
        publishArenaEnergy(c, false)
    }
    assert.deepEqual(
        energyView(packets, 130500).counts,
        [1, 2, 3],
        'fractional reports must not starve the native350ms count/filled callback',
    )
    assert.ok(
        packets.some((packet) => packet.current_points > 100 && packet.current_points < 200),
        'real fractional progress can restore a cleared first cell',
    )
    assert.equal(packets[0].current_points, 100)
    assert.equal(packets.at(-1).current_points, 300)
    for (let i = 1; i < packets.length; i++) assert.ok(packets[i].at - packets[i - 1].at >= 350)
    assert.ok(packets.every((packet) => packet.max_points === 300))
    assert.equal(c.state.combat.npcDuel.energy[1].points, 300)
})

test('a late native main-UI reset does not leave the configured first point unlit until the second point', () => {
    const { c, packets } = context()
    for (let ms = 0; ms <= 5000; ms += 10) {
        c.now = 100 + ms / 1000
        advanceArenaEnergy(c)
        publishArenaEnergy(c, false)
    }
    // The first CostInit callback completed at100350. Native OnMainUIShow
    // then clears all Filled flags while keeping m_lastCost==1.
    const view = energyView(packets, 105000, [100700])
    assert.deepEqual(view.counts, [1])
    assert.deepEqual(
        view.filled,
        [true, false, false],
        'the first existing point needs a changed-value snapshot after the UI reset',
    )
})

test('explicit consumption and resync retain authoritative fractional points without passive timer restarts', () => {
    const { c, packets } = context()
    c.now = 109
    advanceArenaEnergy(c)
    publishArenaEnergy(c)
    assert.equal(packets.at(-1).current_points, 150)
    const count = packets.length
    c.now = 109.3
    advanceArenaEnergy(c)
    publishArenaEnergy(c, false)
    assert.equal(packets.length, count, 'a fractional passive increment does not restart UI transitions')
    consumeArenaPoint(c, 1)
    publishArenaEnergy(c)
    assert.equal(packets.at(-1).current_points, 51)
    const consumed = packets.length
    publishArenaEnergy(c, false)
    assert.equal(packets.length, consumed)
    c.state.combat.npcDuel.energy[1].points = 250.5
    publishArenaEnergy(c)
    assert.equal(packets.at(-1).current_points, 250, 'explicit restore/correction keeps the existing wire precision')
})

test('a whole-point boundary and explicit spend do not wait for the passive UI cadence', () => {
    const { c, packets } = context()
    c.now = 117.9
    advanceArenaEnergy(c)
    publishArenaEnergy(c)
    assert.equal(packets.at(-1).current_points, 199)
    c.now = 118
    advanceArenaEnergy(c)
    publishArenaEnergy(c, false)
    assert.equal(packets.at(-1).current_points, 200)
    const count = packets.length
    c.now = 118.1
    advanceArenaEnergy(c)
    publishArenaEnergy(c, false)
    assert.equal(packets.length, count)
    consumeArenaPoint(c, 1)
    publishArenaEnergy(c)
    assert.equal(packets.at(-1).current_points, 102)
    assert.equal(packets.length, count + 1)
})
