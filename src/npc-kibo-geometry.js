import { ErrorCode } from './error-codes.js'
import fs from 'node:fs'
import { ensure } from './handlers/common.js'

const { prefabs } = JSON.parse(fs.readFileSync(new URL('../configs/npc-arena-geometry.json', import.meta.url), 'utf8'))
const F = Math.fround
const floatError = (value) => Math.max(1, Math.abs(value)) * 8 * 2 ** -23

export function arenaGeometry(tables, duelId) {
    const duel = tables.find('kibo_duel', duelId),
        map = tables.find('kibo_duel_map', duel?.mapId)
    const area = prefabs[map?.prefabID]
    ensure(area, 'Arena deployment geometry unavailable', ErrorCode.GameConfig)
    return area
}

export function arenaPlacementRules(tables, petId) {
    const pet = tables.find('pet', petId),
        unit = tables.find('unit', pet?.unitId)
    ensure(
        unit && Number.isFinite(unit.colliderParm) && unit.colliderParm >= 0,
        'Arena deployment collider unavailable',
        ErrorCode.GameConfig,
    )
    return {
        margin: unit.colliderParm,
        global: String(pet.kiboDuelTag ?? '')
            .split('|')
            .filter(Boolean)
            .some((tag) => Number(tag) === 0),
    }
}

// Direct float-position equivalent of0602a72b/c. The circle uses full3D
// distance; the rectangle explicitly discards Y. Global applies only to the
// native self-area branch, as in0602a72e/0602a729.
export function insideArenaRegion(area, camp, pos, margin = 0, global = false) {
    if (![1, 2].includes(camp) || !['x', 'y', 'z'].every((key) => Number.isFinite(pos[key]))) return false
    const dx = F(pos.x - area.center.x),
        dy = F(pos.y - area.center.y),
        dz = F(pos.z - area.center.z)
    const front = F(F(dx * area.forward.x) + F(dz * area.forward.z)),
        radius = F(area.radius - margin)
    if (radius < 0) return false
    const full = camp === 1 && global
    if (!full && (camp === 1 ? front < 0 : front > 0)) return false
    if (area.shape === 'circle') return F(F(F(dx * dx) + F(dy * dy)) + F(dz * dz)) <= F(radius * radius)
    const side = F(F(dx * -area.forward.z) + F(dz * area.forward.x)),
        width = F(area.side_radius - margin)
    return width >= 0 && Math.abs(front) <= radius && Math.abs(side) <= width
}

// ToServerPos is float32(value*100), truncated toward zero (AzurProto00017).
// Validate the source cell rather than rejecting a valid float that encoded
// just beyond a slanted boundary. Float-product rounding is also bounded.
function sourceInterval(integer) {
    const ulp = (value) => (value === 0 ? 2 ** -149 : 2 ** (Math.floor(Math.log2(Math.abs(value))) - 23))
    const low = integer > 0 ? integer : integer - 1,
        high = integer < 0 ? integer : integer + 1
    return [(low - ulp(low) / 2) / 100, (high + ulp(high) / 2) / 100]
}

function clip(polygon, a, b, bound) {
    if (!polygon.length) return []
    const result = []
    for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i],
            q = polygon[(i + 1) % polygon.length]
        const vp = a * p[0] + b * p[1] - bound,
            vq = a * q[0] + b * q[1] - bound
        if (vp <= 0) result.push(p)
        if (vp <= 0 !== vq <= 0) {
            const t = vp / (vp - vq)
            result.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])])
        }
    }
    return result
}

function nearestSquared(polygon) {
    let min = Infinity,
        positive = false,
        negative = false,
        area = 0
    for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i],
            q = polygon[(i + 1) % polygon.length],
            dx = q[0] - p[0],
            dz = q[1] - p[1]
        const cross = p[0] * q[1] - p[1] * q[0]
        positive ||= cross > 0
        negative ||= cross < 0
        area += cross
        const t = dx || dz ? Math.max(0, Math.min(1, -(p[0] * dx + p[1] * dz) / (dx * dx + dz * dz))) : 0
        min = Math.min(min, (p[0] + t * dx) ** 2 + (p[1] + t * dz) ** 2)
    }
    return polygon.length >= 3 && Math.abs(area) > 1e-16 && !(positive && negative) ? 0 : min
}

export function wirePositionInArena(area, camp, pos, margin = 0, global = false) {
    if (
        ![1, 2].includes(camp) ||
        !['x', 'y', 'z'].every((key) => Number.isInteger(pos?.[key]) && Math.abs(pos[key]) <= 100000000)
    )
        return false
    const radius = area.radius - margin,
        width = area.side_radius - margin
    if (radius < 0 || (area.shape === 'rectangle' && width < 0)) return false
    const x = sourceInterval(pos.x).map((value) => value - area.center.x),
        z = sourceInterval(pos.z).map((value) => value - area.center.z)
    let polygon = [
        [x[0], z[0]],
        [x[1], z[0]],
        [x[1], z[1]],
        [x[0], z[1]],
    ]
    const a = area.forward.x,
        b = area.forward.z,
        full = camp === 1 && global,
        error = floatError(area.radius)
    if (!full) polygon = clip(polygon, camp === 1 ? -a : a, camp === 1 ? -b : b, error)
    if (area.shape === 'rectangle') {
        polygon = clip(polygon, a, b, radius + error)
        polygon = clip(polygon, -a, -b, radius + error)
        polygon = clip(polygon, -b, a, width + error)
        polygon = clip(polygon, b, -a, width + error)
        return polygon.length > 0
    }
    const y = sourceInterval(pos.y).map((value) => value - area.center.y)
    const dy = y[0] > 0 ? y[0] : y[1] < 0 ? y[1] : 0
    return nearestSquared(polygon) + dy * dy <= radius * radius + floatError(radius * radius)
}

export function arenaSummonPositionAllowed(tables, duelId, actor, pos) {
    const rule = arenaPlacementRules(tables, actor.config_id)
    return wirePositionInArena(arenaGeometry(tables, duelId), actor.camp, pos, rule.margin, rule.global)
}
