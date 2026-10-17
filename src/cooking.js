import { ErrorCode } from './error-codes.js'
import { productionTables } from './production-tables.js'
import { ensure } from './handlers/common.js'

export function cookingRecipe(tables, id) {
    tables = productionTables(tables)
    const quality = tables.find('products_multi_quality', id)
    const product = quality && tables.find('products', quality.productId)
    // CookRequest also serves the mill's quality-selectable ingredient recipes.
    // The products table distinguishes processing (2) from cooking (3).
    ensure(
        quality &&
            tables.find('common_item', id) &&
            (product?.type === 2 || (product?.type === 3 && tables.find('food', id))),
        'Unknown cooking recipe',
        ErrorCode.CookConfFail,
    )
    ensure(product.rewardId === `3#${id}#1`, 'Cooking product configuration is missing', ErrorCode.GameConfig)
    const requirements = String(quality.needMaterial ?? '')
        .split('|')
        .filter(Boolean)
        .map((token) => {
            const parts = token.split('#').map(Number)
            ensure(
                parts.length === 3 && parts.every((value) => Number.isSafeInteger(value) && value > 0),
                'Invalid cooking material requirement',
                ErrorCode.GameConfig,
            )
            const [groupId, count, minimumQuality] = parts
            const group = tables.find('food_material_group', groupId)
            ensure(group, 'Cooking material group is missing', ErrorCode.CookMaterialConfFail)
            const choices = String(group.includeItems ?? '')
                .split('|')
                .filter(Boolean)
                .map((token) => {
                    const pair = token.split('#').map(Number)
                    ensure(
                        pair.length === 2 && pair.every((value) => Number.isSafeInteger(value) && value > 0),
                        'Invalid cooking material group',
                        ErrorCode.GameConfig,
                    )
                    return pair
                })
                .filter(([, quality]) => quality >= minimumQuality)
                .map(([id]) => id)
            ensure(choices.length, 'Cooking material quality is unavailable', ErrorCode.CookMaterialConfFail)
            return { count, choices }
        })
    ensure(requirements.length > 0 && requirements.length <= 4, 'Invalid cooking material slots', ErrorCode.GameConfig)
    return { product, requirements }
}

export function cookingMaterials(recipe, items) {
    ensure(Array.isArray(items) && items.length > 0 && items.length <= 32, 'Invalid cooking materials')
    const supplied = new Map()
    for (const item of items) {
        ensure(
            Number.isInteger(item.item_id) && item.item_id > 0 && Number.isInteger(item.item_num) && item.item_num > 0,
            'Invalid cooking material',
        )
        const count = (supplied.get(item.item_id) ?? 0) + item.item_num
        ensure(Number.isSafeInteger(count) && count <= 0xffffffff, 'Cooking material overflow')
        supplied.set(item.item_id, count)
    }
    // Client getCanDoTpl compares each selected slot's quality against the
    // recipe threshold; each slot chooses one item, not a mix of qualities.
    // Backtracking also handles groups that share a selectable ingredient.
    const remaining = new Map(supplied)
    const match = (index) => {
        if (index === recipe.requirements.length) return [...remaining.values()].every((count) => count === 0)
        const { count, choices } = recipe.requirements[index]
        for (const id of choices) {
            const available = remaining.get(id) ?? 0
            if (available < count) continue
            remaining.set(id, available - count)
            if (match(index + 1)) return true
            remaining.set(id, available)
        }
        return false
    }
    ensure(match(0), 'Cooking materials do not match the recipe')
    return supplied
}
