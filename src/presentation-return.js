import { ErrorCode } from './error-codes.js'
import { ensure } from './handlers/common.js'

// Shared by a presentation's explicit exit and a completed cultivation run.
// Restore the saved position, not an arbitrary birth point in the destination.
export function takePresentationReturn(tables, state) {
    const history = (state.worldHistory ??= [])
    while (history.length) {
        const candidate = history.pop()
        const city = tables.find('world_city', candidate.map_id)
        const point = tables.find('world_borthpos', candidate.point_id)
        if (![1, 3, 4].includes(city?.type) || point?.cityId !== candidate.map_id) continue
        ensure(
            candidate.pos && ['x', 'y', 'z'].every((key) => Number.isFinite(candidate.pos[key])),
            'Invalid saved presentation entrance',
        )
        return candidate
    }
    ensure(false, 'Photo/cultivation return context unavailable', ErrorCode.InvalidLogic)
}
