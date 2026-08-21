// Priority: None, Low, Med, High, on a to-do item and on a project card alike.
// The glossary calls it shared vocabulary between the two modules, and it was
// written out in both of them, once with an arrow per level and once without.
// Two copies of a shared vocabulary is what the naming rule exists to stop.
export const PRIORITIES = [
    { v: 0, label: 'None', color: '', icon: '' },
    { v: 1, label: 'Low', color: '#7ed6df', icon: 'keyboard_arrow_down' },
    { v: 2, label: 'Med', color: '#ffbe76', icon: 'keyboard_arrow_up' },
    { v: 3, label: 'High', color: '#ff7979', icon: 'keyboard_double_arrow_up' },
] as const

export type Priority = (typeof PRIORITIES)[number]

// None has neither a colour nor an arrow: the absence of a priority is not a
// level, and drawing it as one puts a mark on every row that never set it.
export const priorityColor = (v: number): string => PRIORITIES.find((p) => p.v === v)?.color || ''
export const priorityIcon = (v: number): string => PRIORITIES.find((p) => p.v === v)?.icon || ''
export const priorityLabel = (v: number): string => PRIORITIES.find((p) => p.v === v)?.label || 'None'
