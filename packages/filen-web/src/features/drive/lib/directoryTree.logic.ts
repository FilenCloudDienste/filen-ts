import type { DirColor } from "@filen/sdk-rs"
import type { DirectoryTreeChild, DirectoryTreeLevel } from "@/features/drive/queries/drive"

// The sidebar tree as one flat list of its visible rows, depth-first, for one virtualizer to window. A row keeps
// its parent's index rather than its whole uuid chain, so a tree of tens of thousands of open rows holds one small
// object per row; the chain is walked back only for the few rows on screen (treeRowPath).

export interface TreeNodeRow {
	readonly kind: "node"
	readonly key: string
	readonly uuid: string
	readonly name: string
	readonly color: DirColor
	// 0 for the drive root's children.
	readonly depth: number
	// The parent node's row, -1 at the top level.
	readonly parentIndex: number
	readonly open: boolean
	// Open, its children still loading their first listing.
	readonly loading: boolean
	// 1-based place among its siblings, and their count.
	readonly posInSet: number
	readonly setSize: number
}

// A level whose listing failed, shown as a line in that level's place.
export interface TreeErrorRow {
	readonly kind: "error"
	readonly key: string
	readonly depth: number
	readonly parentIndex: number
}

export type TreeRow = TreeNodeRow | TreeErrorRow

export interface FlatDirectoryTree {
	readonly rows: readonly TreeRow[]
	readonly indexByUuid: ReadonlyMap<string, number>
}

export type TreeLevels = ReadonlyMap<string | null, DirectoryTreeLevel>

// A listing only ever puts a directory in one place, but two stale cache entries can each claim it (or, moved into
// its own former child, its own ancestor): a uuid already placed is not placed again, which also ends any cycle.
function appendLevel(
	rows: TreeRow[],
	indexByUuid: Map<string, number>,
	levels: TreeLevels,
	isOpen: (uuid: string) => boolean,
	parentUuid: string | null,
	parentIndex: number,
	depth: number
): void {
	const level = levels.get(parentUuid)

	if (level === undefined || level.status === "pending") {
		return
	}

	if (level.status === "error" || level.data === undefined) {
		rows.push({ kind: "error", key: `error:${parentUuid ?? ""}`, depth, parentIndex })

		return
	}

	const children: readonly DirectoryTreeChild[] = level.data

	for (let position = 0; position < children.length; position++) {
		const child = children[position]

		if (child === undefined || indexByUuid.has(child.uuid)) {
			continue
		}

		const index = rows.length
		const open = isOpen(child.uuid)
		const childLevel = open ? levels.get(child.uuid) : undefined

		indexByUuid.set(child.uuid, index)
		rows.push({
			kind: "node",
			key: child.uuid,
			uuid: child.uuid,
			name: child.name,
			color: child.color,
			depth,
			parentIndex,
			open,
			loading: open && (childLevel === undefined || childLevel.status === "pending"),
			posInSet: position + 1,
			setSize: children.length
		})

		if (open) {
			appendLevel(rows, indexByUuid, levels, isOpen, child.uuid, index, depth + 1)
		}
	}
}

// The visible rows below the drive root: each loaded level's directories, an open one followed by its own.
export function flattenDirectoryTree(levels: TreeLevels, isOpen: (uuid: string) => boolean): FlatDirectoryTree {
	const rows: TreeRow[] = []
	const indexByUuid = new Map<string, number>()

	appendLevel(rows, indexByUuid, levels, isOpen, null, -1, 0)

	return { rows, indexByUuid }
}

// The levels the tree must observe: the root's, then, breadth-first, every open directory a loaded level holds. A
// level not observed yet is read from `cached` (the listing cache, never a fetch), so a deep chain of open directories
// whose listings are already held joins in one step rather than one level per render.
export function openTreeParents(
	levels: TreeLevels,
	isOpen: (uuid: string) => boolean,
	cached?: (uuid: string) => readonly DirectoryTreeChild[] | undefined
): (string | null)[] {
	const parents: (string | null)[] = [null]
	const seen = new Set<string>()

	// Iterates the directories it adds too.
	for (const parent of parents) {
		const level = levels.get(parent)
		const children =
			level === undefined ? (parent === null ? undefined : cached?.(parent)) : level.status === "success" ? level.data : undefined

		if (children === undefined) {
			continue
		}

		for (const child of children) {
			if (!seen.has(child.uuid) && isOpen(child.uuid)) {
				seen.add(child.uuid)
				parents.push(child.uuid)
			}
		}
	}

	return parents
}

export function sameTreeParents(a: readonly (string | null)[], b: readonly (string | null)[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index])
}

// The uuid chain from the drive root down to (and including) the node at `index`.
export function treeRowPath(rows: readonly TreeRow[], index: number): string[] {
	const path: string[] = []

	for (let at = index; at >= 0;) {
		const row = rows[at]

		if (row?.kind !== "node") {
			break
		}

		path.push(row.uuid)
		at = row.parentIndex
	}

	return path.reverse()
}

// The row of the node at the end of `path` when it is shown there, else -1.
export function treeIndexOfPath(tree: FlatDirectoryTree, path: readonly string[]): number {
	const last = path.at(-1)
	const index = last === undefined ? undefined : tree.indexByUuid.get(last)

	if (index === undefined) {
		return -1
	}

	const shown = treeRowPath(tree.rows, index)

	return shown.length === path.length && shown.every((uuid, at) => uuid === path[at]) ? index : -1
}

// What a key does on the focused node at `from`, the WAI-ARIA tree pattern's: Up/Down step through the visible
// nodes, Home/End go to the first and last, Right opens a closed node or steps into an open one's first child, Left
// closes an open node or steps out to its parent, Enter (or Space) opens the directory. null when the key is not the tree's.
export interface TreeKeyAction {
	readonly kind: "focus" | "toggle" | "open"
	readonly index: number
}

function nodeFrom(rows: readonly TreeRow[], from: number, step: 1 | -1): number {
	for (let at = from; at >= 0 && at < rows.length; at += step) {
		if (rows[at]?.kind === "node") {
			return at
		}
	}

	return -1
}

// Where a focus key moves from the node at `from`: -1 when it has nowhere to go, null when it moves nothing.
function focusTarget(rows: readonly TreeRow[], from: number, row: TreeNodeRow, key: string): number | null {
	switch (key) {
		case "ArrowDown": {
			return nodeFrom(rows, from + 1, 1)
		}

		case "ArrowUp": {
			return nodeFrom(rows, from - 1, -1)
		}

		case "Home": {
			return nodeFrom(rows, 0, 1)
		}

		case "End": {
			return nodeFrom(rows, rows.length - 1, -1)
		}

		case "ArrowRight": {
			const next = rows[from + 1]

			return next?.kind === "node" && next.parentIndex === from ? from + 1 : -1
		}

		case "ArrowLeft": {
			return row.parentIndex
		}

		default: {
			return null
		}
	}
}

export function treeKeyAction(rows: readonly TreeRow[], from: number, key: string): TreeKeyAction | null {
	const row = rows[from]

	if (row?.kind !== "node") {
		return null
	}

	// Space as well, as on the directory's button the row replaced.
	if (key === "Enter" || key === " ") {
		return { kind: "open", index: from }
	}

	if ((key === "ArrowRight" && !row.open) || (key === "ArrowLeft" && row.open)) {
		return { kind: "toggle", index: from }
	}

	const index = focusTarget(rows, from, row, key)

	if (index === null) {
		return null
	}

	// A key with nowhere to go (Down on the last node) is still the tree's: the page must not scroll.
	return { kind: "focus", index: index === -1 ? from : index }
}
