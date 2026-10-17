import { ErrorCode } from '../error-codes.js'
import { ensureHome } from '../home.js'
import { validatePlacement } from '../home-grid.js'
import { spend } from '../inventory.js'
import { grantRewards } from '../rewards.js'
import { ensure } from './common.js'

function homeInScene(tables, state) {
    const mapId = Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
    ensure(state.world.map_id === mapId, 'Field work requires the home scene')
    return ensureHome(tables, state)
}

function field(tables, home, guid) {
    const build = home.builds.find((item) => item.guid === guid)
    ensure(
        build && tables.get('home_fieldtype').some((row) => row.homeBuildingId === build.build_id),
        'Farmland is not owned',
    )
    return build
}

function seed(tables, itemId, fieldType) {
    const item = tables.find('common_item', itemId)
    ensure(item?.type === 310, 'Item is not a seed')
    const config = tables.find('home_seeds', item.subId)
    ensure(
        config && String(config.fieldType).split('|').map(Number).includes(fieldType),
        'Seed is not compatible with this field',
    )
    return config
}

function growthSeconds(config) {
    const grow = Number(String(config.growParam).split('#')[1])
    const pre = Number(String(config.preHarvestParam).split('|')[1])
    ensure(
        Number.isInteger(grow) && grow > 0 && Number.isInteger(pre) && pre >= 0,
        'Invalid crop growth time',
        ErrorCode.GameConfig,
    )
    return { grow, pre }
}

function clearCrop(build) {
    const { field_type, water_max } = build.crop_info
    build.crop_info = { field_type, water_num: water_max, water_max }
}

function harvest(tables, c, home, build) {
    const crop = build.crop_info
    ensure(
        crop?.seed_id && crop.state === 2 && c.now >= crop.state_finish_time + crop.pre_cost_time,
        'Crop is not ready to harvest',
    )
    const config = tables.find('home_seeds', crop.seed_id)
    ensure(config, 'Missing planted crop configuration', ErrorCode.HomeSeedIdNotInSeedConf)
    const drops = String(config.homeDropId).split('|').filter(Boolean).map(Number)
    const rewards = drops.map((id) => {
        const row = tables.find('home_drop', id)
        ensure(
            row && row.rate === 10000 && row.minValue === row.maxValue && /^\d+$/.test(String(row.itemId)),
            'Unsupported crop drop configuration',
            ErrorCode.InvalidProtoID,
        )
        return { itemtype: row.itemType, itemid: Number(row.itemId), itemnum: row.minValue }
    })
    ensure(rewards.length > 0, 'Crop has no harvest reward', ErrorCode.GameConfig)
    const granted = grantRewards(tables, c.state, rewards)
    clearCrop(build)
    c.state.homeRevision = (c.state.homeRevision || 0) + 1
    return { build_guid: build.guid, reward: { rewards: granted }, drop_ids: drops }
}

export function registerFarming(on, tables) {
    on('FieldOpen', (c, r) => {
        const home = homeInScene(tables, c.state),
            fieldType = tables.find('home_fieldtype', r.field_type)
        ensure(fieldType?.homeBuildingId && r.locate, 'Unknown field type or location')
        const buildId = fieldType.homeBuildingId,
            existing = home.builds.find(
                (build) =>
                    build.build_id === buildId &&
                    build.locate.block_id === r.locate.block_id &&
                    build.locate.anchor === r.locate.anchor,
            )
        if (existing) return existing
        const group = validatePlacement(tables, c.state, buildId, r.locate),
            maxGuid = [...home.builds, ...(home.storedBuilds ?? [])].reduce(
                (max, build) => Math.max(max, build.guid),
                0,
            ),
            guid = Math.max(home.nextBuildGuid || 1, maxGuid + 1)
        ensure(guid <= 0xffffffff, 'Home building GUID space exhausted')
        home.nextBuildGuid = guid + 1
        const build = {
            guid,
            build_id: buildId,
            build_type: group.type,
            status: 1,
            locate: { ...r.locate, direction: r.locate.direction ?? 0 },
            crop_info: {
                field_type: r.field_type,
                water_num: fieldType.waterMax,
                water_max: fieldType.waterMax,
            },
        }
        home.builds.push(build)
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return build
    })

    on('FieldClose', (c, r) => {
        const home = homeInScene(tables, c.state),
            build = field(tables, home, r.field_id)
        ensure(!build.crop_info?.seed_id, 'Planted farmland cannot be closed')
        home.builds = home.builds.filter((item) => item.guid !== build.guid)
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return { rewards: [] }
    })

    on('FieldPlant', (c, r) => {
        const home = homeInScene(tables, c.state)
        ensure(!r.is_pet, 'Pet planting requires an assigned farm worker', ErrorCode.InvalidProtoID)
        ensure(r.plant_info.length > 0 && r.plant_info.length <= 32, 'Invalid planting batch')
        const seen = new Set(),
            costs = new Map(),
            plantings = []
        for (const row of r.plant_info) {
            ensure(
                Number.isInteger(row.build_guid) && row.build_guid > 0 && !seen.has(row.build_guid),
                'Duplicate or invalid planting field',
            )
            seen.add(row.build_guid)
            ensure(
                !row.follower_build_guids?.length,
                'Multi-field planting is not yet supported',
                ErrorCode.InvalidProtoID,
            )
            const build = field(tables, home, row.build_guid)
            ensure(!build.crop_info?.seed_id, 'Farmland already has a crop')
            const config = seed(tables, row.seed_id, build.crop_info.field_type)
            growthSeconds(config)
            costs.set(row.seed_id, (costs.get(row.seed_id) || 0) + 1)
            plantings.push({ build, config })
        }
        spend(c.state, costs, 0, c.now)
        for (const { build, config } of plantings)
            Object.assign(build.crop_info, {
                seed_id: config.id,
                state: 1,
                state_start_time: c.now,
                state_finish_time: 0,
                grow_cost_time: 0,
                pre_cost_time: 0,
                is_player_water: false,
            })
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })

    on('FieldWater', (c, r) => {
        const home = homeInScene(tables, c.state)
        ensure(!r.is_pet, 'Pet watering requires an assigned farm worker', ErrorCode.InvalidProtoID)
        const build = field(tables, home, r.build_guid),
            crop = build.crop_info
        ensure(crop?.seed_id && crop.state === 1, 'Crop does not need watering')
        const config = tables.find('home_seeds', crop.seed_id)
        ensure(config, 'Missing planted crop configuration', ErrorCode.HomeSeedIdNotInSeedConf)
        const { grow, pre } = growthSeconds(config)
        Object.assign(crop, {
            state: 2,
            state_start_time: c.now,
            state_finish_time: c.now + grow,
            grow_cost_time: grow,
            pre_cost_time: pre,
            water_num: crop.water_max,
            is_player_water: true,
        })
        home.manualWaterCount = (home.manualWaterCount || 0) + 1
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })

    on('WaterFinish', (c, r) => {
        const home = homeInScene(tables, c.state)
        ensure(!r.is_pet, 'Pet watering requires an assigned farm worker', ErrorCode.InvalidProtoID)
        const build = field(tables, home, r.build_guid)
        if (build.crop_info?.is_player_water) {
            build.crop_info.is_player_water = false
            c.state.homeRevision = (c.state.homeRevision || 0) + 1
        }
        return {}
    })

    on('FieldUnplant', (c, r) => {
        const home = homeInScene(tables, c.state),
            build = field(tables, home, r.u32)
        ensure(build.crop_info?.seed_id, 'Farmland is empty')
        clearCrop(build)
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return { rewards: [] }
    })

    on('FieldHarvest', (c, r) => {
        const home = homeInScene(tables, c.state)
        ensure(!r.is_pet, 'Pet harvesting requires an assigned farm worker', ErrorCode.InvalidProtoID)
        return harvest(tables, c, home, field(tables, home, r.build_guid))
    })

    on('FieldHarvestList', (c, r) => {
        const home = homeInScene(tables, c.state)
        ensure(!r.is_pet, 'Pet harvesting requires an assigned farm worker', ErrorCode.InvalidProtoID)
        ensure(
            r.build_guids.length > 0 &&
                r.build_guids.length <= 32 &&
                new Set(r.build_guids).size === r.build_guids.length,
            'Invalid harvest batch',
        )
        const builds = r.build_guids.map((guid) => field(tables, home, guid))
        for (const build of builds) {
            const crop = build.crop_info
            ensure(
                crop?.seed_id && crop.state === 2 && c.now >= crop.state_finish_time + crop.pre_cost_time,
                'Crop is not ready to harvest',
            )
        }
        return { results: builds.map((build) => harvest(tables, c, home, build)) }
    })
}
