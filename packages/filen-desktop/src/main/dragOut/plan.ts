import type { DesktopDragRefusal } from "@filen/shared/desktop"
import { keepBothName, localCollisionKey, localName, type LocalPlatform } from "@filen/shared/localName"
import type { NativeTreeEntry } from "../../shared/nativeProtocol.ts"

// What a drag-out puts on the OS: the dragged trees' entries with local relative paths.

// relativePath: local names joined with the platform's separator, the dragged item's name first. listIndex and
// source as the listing gave them.
export interface DragEntry {
	relativePath: string
	directory: boolean
	size: number
	mtimeMs: number | null
	listIndex: number | null
	source: number
}

// maxRelativePathUnits: in UTF-16 units, after naming. null: no cap.
export interface DragPlanLimits {
	maxEntries: number
	maxBytes: number | null
	maxRelativePathUnits: number | null
}

// Explorer's file descriptors: 10,000 per drag, MAX_PATH less the terminator per path.
export const WINDOWS_LIMITS: DragPlanLimits = { maxEntries: 10_000, maxBytes: null, maxRelativePathUnits: 259 }

// A copy staged on disk before the OS drag starts.
export const STAGED_LIMITS: DragPlanLimits = { maxEntries: 2_000, maxBytes: 512 * 1024 ** 2, maxRelativePathUnits: null }

interface Named {
	entry: NativeTreeEntry
	// The raw path that identifies the entry's parent ("" for the dragged items, which share one directory).
	parent: string
	name: string
}

function rawKey(source: number, segments: readonly string[], end: number): string {
	return `${source}\0${segments.slice(0, end).join("\0")}`
}

// Within each directory, every entry first reserves its own collision key (the first to hold one keeps it); a later
// entry on a held key takes the first keep-both name free among all of them, so "a, a, a (1)" gives "a, a (2), a (1)".
function nameSiblings(siblings: readonly Named[]): void {
	const owners = new Map<string, Named>()

	for (const sibling of siblings) {
		const key = localCollisionKey(sibling.name)

		if (!owners.has(key)) {
			owners.set(key, sibling)
		}
	}

	const taken = new Set(owners.keys())

	for (const sibling of siblings) {
		if (owners.get(localCollisionKey(sibling.name)) === sibling) {
			continue
		}

		const kind = sibling.entry.directory ? "directory" : "file"
		let n = 1
		let candidate = keepBothName(sibling.name, n, kind)

		while (taken.has(localCollisionKey(candidate))) {
			n++
			candidate = keepBothName(sibling.name, n, kind)
		}

		taken.add(localCollisionKey(candidate))
		sibling.name = candidate
	}
}

/**
 * Local relative paths for a drive tree listing, parents before children, empty directories kept. Every segment is a
 * localName; colliding siblings get keep-both names. Refused past the entry count, the file bytes or (after naming) the
 * path length in `limits`.
 */
export function planEntries(
	entries: readonly NativeTreeEntry[],
	limits: DragPlanLimits,
	platform: LocalPlatform
): { entries: DragEntry[] } | { refused: DesktopDragRefusal } {
	if (entries.length > limits.maxEntries) {
		return { refused: { reason: "tooMany", entries: entries.length, limit: limits.maxEntries } }
	}

	if (limits.maxBytes !== null) {
		let bytes = 0

		for (const entry of entries) {
			if (!entry.directory) {
				bytes += entry.size
			}
		}

		if (bytes > limits.maxBytes) {
			return { refused: { reason: "tooLarge", bytes, limit: limits.maxBytes } }
		}
	}

	const directories = new Map<string, Named[]>()
	const named: Named[] = []

	for (const entry of entries) {
		const depth = entry.segments.length
		const item: Named = {
			entry,
			parent: depth === 1 ? "" : rawKey(entry.source, entry.segments, depth - 1),
			name: localName(entry.segments[depth - 1] ?? "", platform)
		}
		const siblings = directories.get(item.parent)

		if (siblings === undefined) {
			directories.set(item.parent, [item])
		} else {
			siblings.push(item)
		}

		named.push(item)
	}

	for (const siblings of directories.values()) {
		nameSiblings(siblings)
	}

	// A stable sort by depth puts every parent before its children and keeps the listing's order otherwise.
	named.sort((a, b) => a.entry.segments.length - b.entry.segments.length)

	const separator = platform === "win32" ? "\\" : "/"
	const localDirectories = new Map<string, string>()
	const planned: DragEntry[] = []

	for (const { entry, parent, name } of named) {
		const depth = entry.segments.length
		let relativePath = name

		if (depth > 1) {
			// A parent the listing left out (it never does) is named segment by segment.
			const parentPath =
				localDirectories.get(parent) ??
				entry.segments
					.slice(0, depth - 1)
					.map(segment => localName(segment, platform))
					.join(separator)

			relativePath = parentPath + separator + name
		}

		if (limits.maxRelativePathUnits !== null && relativePath.length > limits.maxRelativePathUnits) {
			return { refused: { reason: "pathTooLong", path: relativePath } }
		}

		if (entry.directory) {
			localDirectories.set(rawKey(entry.source, entry.segments, depth), relativePath)
		}

		planned.push({
			relativePath,
			directory: entry.directory,
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			listIndex: entry.listIndex,
			source: entry.source
		})
	}

	return { entries: planned }
}
