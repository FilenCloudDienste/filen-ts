import { pathIsUnder } from "@/features/shell/lib/appShell.logic"

// The icon rail's reorderable links. The logo above them and the help/account footer below stay put.
export const RAIL_ENTRY_IDS = [
	"drive",
	"photos",
	"videos",
	"transfers",
	"sync",
	"notes",
	"chats",
	"playlists",
	"contacts",
	"settings"
] as const

export type RailEntryId = (typeof RAIL_ENTRY_IDS)[number]

export const DEFAULT_RAIL_ORDER: readonly RailEntryId[] = RAIL_ENTRY_IDS

// Entries only the desktop app can serve. The stored order still holds them in a browser, so a reorder
// there never loses their slot for a later desktop session on the same origin.
const DESKTOP_ONLY = new Set<RailEntryId>(["sync"])

const KNOWN = new Set<string>(RAIL_ENTRY_IDS)

function isRailEntryId(id: string): id is RailEntryId {
	return KNOWN.has(id)
}

// A stored order kept to what this build renders: unknown and repeated ids are dropped, and an entry
// the stored order lacks (one added since it was saved) goes right after the entry that precedes it in
// the default order, or first when none does, so no link can go missing and a new one lands where it
// belongs rather than at the end.
export function normalizeRailOrder(stored: readonly string[] | null): RailEntryId[] {
	if (stored === null) {
		return [...DEFAULT_RAIL_ORDER]
	}

	const order: RailEntryId[] = []

	for (const id of stored) {
		if (isRailEntryId(id) && !order.includes(id)) {
			order.push(id)
		}
	}

	for (const [index, id] of DEFAULT_RAIL_ORDER.entries()) {
		if (order.includes(id)) {
			continue
		}

		let at = 0

		for (let before = index - 1; before >= 0; before--) {
			const predecessor = DEFAULT_RAIL_ORDER[before]
			const placed = predecessor === undefined ? -1 : order.indexOf(predecessor)

			if (placed !== -1) {
				at = placed + 1

				break
			}
		}

		order.splice(at, 0, id)
	}

	return order
}

// The entries this runtime renders, in the stored order.
export function visibleRailOrder(order: readonly RailEntryId[], runtime: { desktop: boolean }): RailEntryId[] {
	return runtime.desktop ? [...order] : order.filter(id => !DESKTOP_ONLY.has(id))
}

// The full stored order after the visible entries were reordered to `visibleNext`: every hidden entry
// keeps its slot and the visible ones fill the others in their new order.
export function mergeRailOrder(full: readonly RailEntryId[], visibleNext: readonly RailEntryId[]): RailEntryId[] {
	const visible = new Set(visibleNext)
	const merged: RailEntryId[] = []
	let next = 0

	for (const id of full) {
		if (!visible.has(id)) {
			merged.push(id)

			continue
		}

		merged.push(visibleNext[next] ?? id)
		next += 1
	}

	return merged
}

// `order` with the entry at `from` moved to `to`, the others keeping their relative order.
export function moveRailEntry(order: readonly RailEntryId[], from: number, to: number): RailEntryId[] {
	const next = [...order]
	const [moved] = next.splice(from, 1)

	if (moved === undefined) {
		return next
	}

	next.splice(Math.min(Math.max(to, 0), next.length), 0, moved)

	return next
}

// The slot a dragged entry lands in: its start slot moved by however many whole slots the pointer has
// travelled, rounded to the nearest, within the list.
export function railDropIndex(from: number, deltaY: number, pitch: number, count: number): number {
	if (pitch <= 0 || count <= 0) {
		return from
	}

	return Math.min(Math.max(from + Math.round(deltaY / pitch), 0), count - 1)
}

// How far an undragged entry shifts to open the gap at `to` for the entry dragged from `from`: one
// slot toward `from` if it sits between them, otherwise not at all.
export function railShift(index: number, from: number, to: number, pitch: number): number {
	if (from < to && index > from && index <= to) {
		return -pitch
	}

	if (to < from && index >= to && index < from) {
		return pitch
	}

	return 0
}

// Whether `pathname` is inside the section an entry links to. Drive, Videos, Sync, Notes, Chats and Settings nest
// deeper routes under their root; the others are single pages.
export function railEntryActive(id: RailEntryId, pathname: string): boolean {
	switch (id) {
		case "drive":
			return pathIsUnder(pathname, "/drive")
		case "notes":
			return pathIsUnder(pathname, "/notes")
		case "chats":
			return pathIsUnder(pathname, "/chats")
		case "settings":
			return pathIsUnder(pathname, "/settings")
		case "photos":
			return pathname === "/photos"
		case "videos":
			return pathIsUnder(pathname, "/videos")
		case "transfers":
			return pathname === "/transfers"
		case "sync":
			return pathIsUnder(pathname, "/sync")
		case "playlists":
			return pathname === "/playlists"
		case "contacts":
			return pathname === "/contacts"
	}
}
