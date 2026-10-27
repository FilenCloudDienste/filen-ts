import { pathIsUnder } from "@/features/shell/lib/appShell.logic"

// Rail entries that hold several modules behind one icon: a click opens the child used last, a hover or
// ArrowRight opens a flyout listing every child. Each child keeps its own route and its own last-opened item.
export type RailGroupId = "media" | "computer"

export type RailChildId = "photos" | "videos" | "playlists" | "sync" | "mounts"

// In flyout order; the first is where a group goes before any child was opened.
export const RAIL_GROUP_CHILDREN: Readonly<Record<RailGroupId, readonly [RailChildId, ...RailChildId[]]>> = {
	media: ["photos", "videos", "playlists"],
	computer: ["sync", "mounts"]
}

// The route a child links to. Videos, Sync and Mounts nest deeper routes; their bare roots reopen what was
// open last (playlists reads its own last-opened value when linked bare).
export const RAIL_CHILD_ROUTE = {
	photos: "/photos",
	videos: "/videos",
	playlists: "/playlists",
	sync: "/sync",
	mounts: "/mounts"
} as const satisfies Record<RailChildId, string>

export function railChildActive(id: RailChildId, pathname: string): boolean {
	switch (id) {
		case "photos":
		case "playlists":
			return pathname === RAIL_CHILD_ROUTE[id]
		case "videos":
		case "sync":
		case "mounts":
			return pathIsUnder(pathname, RAIL_CHILD_ROUTE[id])
	}
}

// The child whose section `pathname` is in, null when none of the group's.
export function activeRailChild(group: RailGroupId, pathname: string): RailChildId | null {
	return RAIL_GROUP_CHILDREN[group].find(id => railChildActive(id, pathname)) ?? null
}

// Where a click on the group goes: the stored child while it still belongs to the group, else the first.
export function railGroupTarget(group: RailGroupId, stored: string | null | undefined): RailChildId {
	const children = RAIL_GROUP_CHILDREN[group]

	return children.find(id => id === stored) ?? children[0]
}

// A child's status dot. Attention (something failed or waits on the user) outranks work in progress.
export type RailDot = "attention" | "busy" | null

// The dot a group icon shows for its children: the most urgent one any child shows.
export function bubbleRailDot(dots: readonly RailDot[]): RailDot {
	if (dots.includes("attention")) {
		return "attention"
	}

	return dots.includes("busy") ? "busy" : null
}
