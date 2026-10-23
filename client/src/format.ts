// Shared date/time formatting for the PWA. Every rendered time flows through
// here so the user's 12h/24h preference (prefs.timeFormat) is applied
// consistently: chat, audit log, and moment timestamps included. Reading
// `prefs()` inside these helpers makes callers reactive to the pref, so times
// re-render live when it changes.

import { prefs } from './prefs'

// Resolve the `hour12` option from the pref. `undefined` = follow the locale.
function hour12(): boolean | undefined {
    switch (prefs().timeFormat) {
        case '12h':
            return true
        case '24h':
            return false
        default:
            return undefined
    }
}

function toDate(input: string | number | Date): Date {
    return input instanceof Date ? input : new Date(input)
}

// formatTime renders just the clock (e.g. "3:47 PM" or "15:47").
export function formatTime(input: string | number | Date): string {
    return toDate(input).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: hour12(),
    })
}

// formatDate renders just the calendar date (e.g. "Jul 23, 2026").
export function formatDate(input: string | number | Date): string {
    return toDate(input).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    })
}

// formatDayHeading renders a full calendar date for the divider above the
// first message of a day (e.g. "October 20, 2026").
export function formatDayHeading(input: string | number | Date): string {
    return toDate(input).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    })
}

// formatNumericDateTime renders a numeric date followed by the clock, for a
// message stamp from any day but today (e.g. "8/21/2026 5:19 PM"). It is
// numeric because it shares an 11px line with the author's name.
export function formatNumericDateTime(input: string | number | Date): string {
    const date = toDate(input)
    const day = date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
    })
    return `${day} ${formatTime(date)}`
}

// formatDateTime renders date + time, used where a precise stamp matters
// (audit log). Seconds are included for disambiguation.
export function formatDateTime(input: string | number | Date): string {
    return toDate(input).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: hour12(),
    })
}
