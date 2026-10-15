import { ensure } from './handlers/common.js'

// Client skill timelines use60fps. This is our scheduling resolution, not a
// claim about the official backend's update rate.
export const ARENA_TICK_HZ = 60
export const ARENA_TIMER_MS = Math.floor(1000 / ARENA_TICK_HZ)
export const secondsToArenaMs = (seconds) => Math.round(seconds * 1000)

export function arenaMillis(c) {
    const value = c.arena_now_ms ?? secondsToArenaMs(c.now)
    ensure(Number.isSafeInteger(value) && value >= 0, 'Arena millisecond clock unavailable', 1007)
    return value
}

export function arenaContext(c) {
    if (c.arena_clock_context || c.arena_now_ms === undefined) return c
    return { ...c, now: arenaMillis(c) / 1000, arena_clock_context: true }
}
