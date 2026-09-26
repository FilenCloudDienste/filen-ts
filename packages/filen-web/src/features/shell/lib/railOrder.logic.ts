// The icon rail's reorderable links. The logo above them and the help/account footer below stay put.
export const RAIL_ENTRY_IDS = ["drive", "photos", "transfers", "notes", "chats", "playlists", "contacts", "settings"] as const

export type RailEntryId = (typeof RAIL_ENTRY_IDS)[number]

export const DEFAULT_RAIL_ORDER: readonly RailEntryId[] = RAIL_ENTRY_IDS

const KNOWN = new Set<string>(RAIL_ENTRY_IDS)

function isRailEntryId(id: string): id is RailEntryId {
	return KNOWN.has(id)
}

// A stored order kept to what this build renders: unknown and repeated ids are dropped, and an entry
// the stored order lacks (one added since it was saved) is appended, so no link can go missing.
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

	for (const id of DEFAULT_RAIL_ORDER) {
		if (!order.includes(id)) {
			order.push(id)
		}
	}

	return order
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

// Whether `pathname` is inside the section an entry links to. Drive, Notes, Chats and Settings nest
// deeper routes under their root; the others are single pages.
export function railEntryActive(id: RailEntryId, pathname: string): boolean {
	const under = (root: string): boolean => pathname === root || pathname.startsWith(`${root}/`)

	switch (id) {
		case "drive":
			return under("/drive")
		case "notes":
			return under("/notes")
		case "chats":
			return under("/chats")
		case "settings":
			return under("/settings")
		case "photos":
			return pathname === "/photos"
		case "transfers":
			return pathname === "/transfers"
		case "playlists":
			return pathname === "/playlists"
		case "contacts":
			return pathname === "/contacts"
	}
}
