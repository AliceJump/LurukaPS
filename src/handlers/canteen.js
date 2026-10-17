import { ErrorCode } from '../error-codes.js'
import { ensureHome } from '../home.js'
import { spend, addItems } from '../inventory.js'
import { ensure } from './common.js'

function foodScore(tables, id) {
    const item = tables.find('common_item', id)
    ensure(item?.type === 355, 'Item is not pet food')
    const food = tables.find('food', id)
    ensure(
        Number.isInteger(food?.satietyScore) && food.satietyScore > 0,
        'Food has no canteen satiety configuration',
        ErrorCode.InvalidProtoID,
    )
    return food.satietyScore
}

export function registerCanteen(on, tables) {
    on('AddPetFood', (c, r) => {
        const home = ensureHome(tables, c.state)
        const homeMapId = Number(tables.get('game').find((row) => row.title === 'HOME_ID')?.value)
        ensure(c.state.world.map_id === homeMapId, 'Pet table requires the home scene')
        const build = home.builds.find((entry) => entry.guid === r.build_guid)
        ensure(build?.build_type === 6 && [1, 4].includes(build.status), 'Pet table is not owned or placed')
        ensure(
            [0, 1].includes(r.operate_type) && r.items.length > 0 && r.items.length <= 32,
            'Invalid pet food operation',
        )
        const items = new Map()
        for (const entry of r.items) {
            ensure(
                Number.isInteger(entry.itemid) &&
                    entry.itemid > 0 &&
                    Number.isInteger(entry.itemnum) &&
                    entry.itemnum > 0,
                'Invalid food quantity',
            )
            foodScore(tables, entry.itemid)
            const count = (items.get(entry.itemid) || 0) + entry.itemnum
            ensure(Number.isSafeInteger(count) && count <= 0xffffffff, 'Food quantity overflow')
            items.set(entry.itemid, count)
        }
        const canteen = build.pet_canteen ?? {
            pets: [],
            food_value: 0,
            foods: [],
            food_extra_ids: [],
            food_extra_values: [],
        }
        const foods = new Map(canteen.foods.map((entry) => [entry.itemid, entry.itemnum]))
        for (const [id, count] of items) {
            const next = (foods.get(id) || 0) + (r.operate_type === 1 ? count : -count)
            ensure(next >= 0 && next <= 0xffffffff, 'Food is not stocked in this pet table')
            if (next) foods.set(id, next)
            else foods.delete(id)
        }
        const foodValue = [...foods].reduce((sum, [id, count]) => sum + count * foodScore(tables, id), 0)
        const capacity = Number(tables.find('home_building', build.build_id)?.trough)
        ensure(
            Number.isSafeInteger(foodValue) && Number.isInteger(capacity) && capacity > 0 && foodValue <= capacity,
            'Pet table food capacity exceeded',
        )
        if (r.operate_type === 1) spend(c.state, items, 0, c.now)
        else
            addItems(
                c.state,
                [...items].map(([itemid, itemnum]) => ({ itemid, itemnum })),
            )
        build.pet_canteen = {
            ...canteen,
            food_value: foodValue,
            foods: [...foods].map(([itemid, itemnum]) => ({ itemid, itemnum, itemtype: 3 })),
        }
        c.state.homeRevision = (c.state.homeRevision || 0) + 1
        return {}
    })
}
