import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// SPSystem resets these base values in InitKiboRingConfig. Reports contain
// absolute dynamic components; external components are frozen at arena entry.
const spProperties = new Set([6, 105, 110, 226, 227])
// DataPropertyUtility.battlePropertyRatioFilterList, not battle_info.isRatio.
const wireScaled = new Set([1, 3, 5, 201, 229, 230])
const catalogs = new WeakMap()
const F = Math.fround,
    Q = 65536n,
    MIN = -(1n << 63n),
    MAX = (1n << 63n) - 1n
const q = (value) => BigInt(Math.trunc(F(F(value) * 65536)))
const add = (a, b) => BigInt.asIntN(64, a + b)
const mul = (a, b) => BigInt.asIntN(64, (a * b) >> 16n)
function div(a, b) {
    if (!b) return 0n
    const absolute = (value) => (value < 0n ? -value : value)
    const result = ((absolute(a) << 17n) / absolute(b) + 1n) >> 1n
    const signed = a < 0n !== b < 0n ? -result : result
    return signed < MIN ? MIN : signed > MAX ? MAX : signed
}
const toFloat = (value) => F(F(Number(value)) / 65536)

function propertyCatalog(tables) {
    let catalog = catalogs.get(tables)
    if (!catalog) {
        catalog = new Map(tables.get('battle_info').map((row) => [row.attrVal, row]))
        catalogs.set(tables, catalog)
    }
    return catalog
}

export function arenaBaseProperties(tables, attrs) {
    const catalog = propertyCatalog(tables),
        properties = {}
    // PackAttrInfoByFightAttr converts int64 to float before the scale filter.
    for (const attr of attrs?.attrs ?? []) {
        const id = attr.attr_id
        if (!id || !catalog.has(id)) continue
        const raw = F(Number(attr.attr_val)),
            value = wireScaled.has(id) ? F(raw / 10000) : raw
        ensure(Number.isFinite(value), 'Invalid arena base attribute', ErrorCode.GameConfig)
        const row = properties[id] ?? { base: 0, extra: 0, percent: 0 },
            group = Math.trunc(id / 1000)
        if (group === 0) row.base = F(row.base + value)
        else if (group === 1) row.percent = F(row.percent + F(value / 10000))
        else if (group === 2) row.extra = F(row.extra + value)
        const [parent, member] = String(catalog.get(id).attrGroup).split('|').map(Number)
        if (parent > 0 && parent !== id) {
            const target = properties[parent] ?? { base: 0, extra: 0, percent: 0 }
            if (member === 2) target.percent = row.percent
            else if (member === 3) target.extra = row.extra
            properties[parent] = target
        }
        properties[id] = row
    }
    // AliveData.SetAllBasePropertyValue truncates only the HP external base.
    if (properties[5]) properties[5].base = Math.trunc(properties[5].base)
    return properties
}

function dynamic(values, type, tags = null) {
    let value = toFloat(q(values[`${type}:0`] ?? 0))
    for (const tag of tags ?? []) {
        if (tag) value = toFloat(add(q(value), q(values[`${type}:${tag}`] ?? 0)))
    }
    return q(value)
}

export function arenaProperty(c, uuid, id, base, normalized = true, tags = null, component = 0, snapshot = null) {
    const catalog = propertyCatalog(c.tables)
    const row = catalog.get(id)
    ensure(row, 'Arena property configuration unavailable', ErrorCode.GameConfig)
    const actor = c.state.combat.npcDuel?.actors?.[uuid]
    const bases = snapshot ? snapshot.base_properties : actor?.base_properties
    let external = bases?.[id]
    if (base !== undefined) external = { base, extra: 0, percent: 0 }
    else if (!external && spProperties.has(id)) external = { base: 0, extra: 0, percent: 0 }
    else if (!external) {
        ensure(bases, 'Arena base properties unavailable', ErrorCode.GameConfig)
        if (row.attrDefault === -10000) return 0 // This property was not installed by the client.
        external = { base: row.attrDefault, extra: 0, percent: 0 }
    }
    const values = (snapshot ? snapshot.arena_properties : c.state.combat.entities[uuid]?.arena_properties)?.[id] ?? {}
    return propertyValue(row, external, values, normalized, tags, component, snapshot?.native_snapshot === true)
}

export function arenaBasePropertyValue(tables, bases, id) {
    const row = propertyCatalog(tables).get(id)
    ensure(row && bases, 'Arena base property configuration unavailable', ErrorCode.GameConfig)
    if (!bases[id] && row.attrDefault === -10000) return 0
    return propertyValue(row, bases[id] ?? { base: row.attrDefault, extra: 0, percent: 0 }, {}, false, null, 0)
}

function propertyValue(row, external, values, normalized, tags, component, nativeSnapshot = false) {
    const staticBase = q(external.base),
        staticExtra = q(external.extra),
        staticPercent = q(external.percent)
    const baseValue = add(mul(staticBase, add(Q, staticPercent)), staticExtra)
    // CalcSpecificAttributeValue's component selectors are unnormalized and
    // bypass final-value force/clamps. Selectors5/6 explicitly use null tags.
    ensure(Number.isInteger(component) && component >= 0 && component <= 6, 'Unknown arena property component')
    // CloneBattlePropertyTo never assigns SimplePropertyData.externalPercentValue;
    // the native snapshot selector therefore reads its initialized zero field.
    if (nativeSnapshot && component === 3) return 0
    if (component > 0 && component < 5)
        return toFloat([null, staticBase, staticExtra, staticPercent, baseValue][component])
    if (component === 5 || component === 6) return toFloat(dynamic(values, component - 1))
    const ratio = row.isCalRatio === 1 ? 10000n : row.isCalRatio === 2 ? 1000n : 1n
    const raw =
        values['6:0'] !== undefined
            ? q(values['6:0'])
            : add(
                  mul(add(baseValue, dynamic(values, 3, tags)), add(Q, dynamic(values, 5, tags))),
                  dynamic(values, 4, tags),
              )
    // GetPropertyValue crosses MyFloat -> float -> MyFloat before Clamp.
    let result = q(toFloat(div(raw, (normalized ? ratio : 1n) * Q)))
    // Native clamps use the table ratio, even for an unnormalized read.
    if (row.useMininumValue) {
        const minimum = q(toFloat(div(q(row.minimumValue), ratio * Q)))
        if (result < minimum) result = minimum
    }
    if (row.useMaximumValue) {
        const maximum = q(toFloat(div(q(row.maximumValue), ratio * Q)))
        if (result > maximum) result = maximum
    }
    const value = toFloat(result)
    // SnapshotPropertyManager.GetValue has no AliveProperty HP integer cast.
    return row.attrVal === 5 && !nativeSnapshot ? Math.trunc(value) : value
}

export function captureArenaProperties(c, uuid) {
    const base = c.state.combat.npcDuel?.actors[uuid]?.base_properties
    ensure(base, 'Arena base properties unavailable', ErrorCode.GameConfig)
    return structuredClone({
        base_properties: base,
        arena_properties: c.state.combat.entities[uuid]?.arena_properties ?? {},
    })
}

export function mergeArenaProperties(c, request) {
    const uuid = String(request.uuid),
        run = c.state.combat?.npcDuel
    if (!run?.actors[uuid] || run.map_id !== c.state.world.map_id || run.result) return false
    const catalog = propertyCatalog(c.tables)
    const updates = (request.attrButeInfos ?? []).filter((row) => catalog.has(row.attrId))
    if (!updates.length) return false
    const previous = c.state.combat.entities[uuid],
        properties = { ...previous.arena_properties }
    for (const row of updates) {
        ensure((row.attr_values ?? []).length <= 256, 'Too many arena property components')
        const values = { ...properties[row.attrId] }
        for (const entry of row.attr_values ?? []) {
            const type = entry.attr_type ?? 0,
                tag = entry.attr_tag ?? 0,
                value = entry.value ?? 0
            if (![3, 4, 5, 6].includes(type)) continue // Native ignores other types in this report.
            ensure(Number.isFinite(value) && Math.abs(value) < 2 ** 47, 'Invalid arena property value')
            const key = type === 6 ? '6:0' : `${type}:${tag}`
            if ((type === 6 && value === -100000) || (type !== 6 && value === 0)) delete values[key]
            else values[key] = value
        }
        ensure(Object.keys(values).length <= 256, 'Too many stored arena property components')
        properties[row.attrId] = values
    }
    c.state.combat.entities = {
        ...c.state.combat.entities,
        [uuid]: { ...previous, arena_properties: properties },
    }
    return true
}
