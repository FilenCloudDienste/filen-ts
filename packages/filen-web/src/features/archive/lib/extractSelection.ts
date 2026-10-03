import type { ArchiveFormat } from "@filen/sdk-rs"
import type { JobDestination } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { ENTRY_FLAG, ENTRY_KIND } from "@/lib/sdk/archiveListing"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"
import type { ExtractJobRequest } from "@/features/drive/lib/archiveJobs.logic"
import { extractRequestShape } from "@/features/drive/lib/archiveTargets"
import { cachedDirectoryName } from "@/features/drive/queries/drive"
import { startExtractWithCard } from "@/features/transfers/lib/archiveToast"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingSession, ListSummary } from "@/features/archive/lib/listingSession"
import { isSelected, type Selection } from "@/features/archive/lib/selection"
import { dirRef } from "@/features/archive/lib/sortedChildren"

// The browser's selection as extract calls. Which entries an extract names depends on the format: a
// zip's or 7z's directory entry brings everything below it, a tar's only what it stores after it.

export type ResolvedSelection =
	| { kind: "all" }
	| {
			kind: "entries"
			// ArchiveEntryId.index of each entry the call names, ascending.
			indexes: number[]
			// What the extract creates, the entries the named directories bring included.
			files: number
			bytes: number
			// Hard-link targets named for links that were selected without them.
			linkTargetsAdded: number
			// Targets outside the base directory, which an extract below it refuses.
			outsideBase: number[]
			// The selected hard links needing those targets, to be left out when the user says so.
			outsideLinks: number[]
			// An entry the extract creates is encrypted.
			encrypted: boolean
	  }

export type ExtractTarget = { type: "besideNewFolder" } | { type: "beside" } | { type: "directory"; destination: JobDestination }

type FormatType = ArchiveFormat["type"]

// A zip's or 7z's directory entry brings its whole subtree.
function bringsSubtree(format: FormatType | null): boolean {
	return format === "zip" || format === "sevenZ"
}

function isFileKind(kind: number): boolean {
	return kind === ENTRY_KIND.file || kind === ENTRY_KIND.hardlink
}

function isBelow(store: EntryStore, dir: number, ancestor: number): boolean {
	for (let node = dir; node >= 0; node = store.dirParent(node)) {
		if (node === ancestor) {
			return true
		}
	}

	return false
}

function hasEncrypted(store: EntryStore, dir: number): boolean {
	for (const slot of store.childEntries(dir)) {
		if ((store.flags(slot) & ENTRY_FLAG.encrypted) !== 0) {
			return true
		}
	}

	return store.childDirs(dir).some(child => hasEncrypted(store, child))
}

// `format` is the listing's, else the name's guess; an unknown one is read as a tar, whose rules name
// every entry either way would need. `complete` is false for a listing that was stopped or failed: all
// of its rows is not all of the archive.
export function resolveSelection(
	store: EntryStore,
	selection: Selection,
	baseDir: number,
	format: FormatType | null,
	complete = true
): ResolvedSelection {
	const { rules, inner } = selection

	if (complete && baseDir === 0 && rules.get(dirRef(0)) === true && inner.size === 0) {
		return { kind: "all" }
	}

	const indexes: number[] = []
	// Every hard link the extract creates, named or brought.
	const links: number[] = []
	let files = 0
	let bytes = 0
	let encrypted = false

	const emit = (slot: number): void => {
		indexes.push(store.index(slot))
	}

	const coverEntry = (slot: number): void => {
		const kind = store.kind(slot)

		if (isFileKind(kind)) {
			files += 1
			bytes += Math.max(store.size(slot), 0)
		}

		if (kind === ENTRY_KIND.hardlink) {
			links.push(slot)
		}

		if ((store.flags(slot) & ENTRY_FLAG.encrypted) !== 0) {
			encrypted = true
		}
	}

	// A directory selected with nothing excluded below it. `cutoff`: the lowest index among the tar
	// directory entries already named above it, which bring whatever they store after themselves.
	const whole = (dir: number, cutoff: number, isBase: boolean): void => {
		const own = isBase ? -1 : store.dirEntrySlot(dir)
		let below = cutoff

		if (own >= 0 && store.skip(own) === 0) {
			if (bringsSubtree(format)) {
				emit(own)
				files += store.aggFiles(dir)
				bytes += store.aggBytes(dir)
				encrypted ||= hasEncrypted(store, dir)

				return
			}

			const index = store.index(own)

			if (index < cutoff) {
				emit(own)
				below = index
			}
		}

		for (const slot of store.childEntries(dir)) {
			if (store.skip(slot) === 0) {
				coverEntry(slot)

				if (store.index(slot) < below) {
					emit(slot)
				}
			}
		}

		for (const child of store.childDirs(dir)) {
			whole(child, below, false)
		}
	}

	// `on`: what the directory takes from above, its own rule aside.
	const visit = (dir: number, on: boolean, isBase: boolean): void => {
		const state = rules.get(dirRef(dir)) ?? on

		if (!inner.has(dir)) {
			if (state) {
				whole(dir, Infinity, isBase)
			}

			return
		}

		// Mixed: its own entry would bring what is excluded, so only what is in is named.
		for (const slot of store.childEntries(dir)) {
			if ((rules.get(slot) ?? state) && store.skip(slot) === 0) {
				coverEntry(slot)
				emit(slot)
			}
		}

		for (const child of store.childDirs(dir)) {
			visit(child, state, false)
		}
	}

	let baseOn = false

	for (let dir = store.dirParent(baseDir); dir >= 0; dir = store.dirParent(dir)) {
		const rule = rules.get(dirRef(dir))

		if (rule !== undefined) {
			baseOn = rule

			break
		}
	}

	visit(baseDir, baseOn, true)

	// Each link's target chain, once: whether it ends outside the base, and what it adds.
	const reachesOutside = new Map<number, boolean>()
	const added = new Set<number>()
	const outsideBase = new Set<number>()
	const outsideLinks: number[] = []
	let linkTargetsAdded = 0

	const covered = (slot: number): boolean => added.has(slot) || isSelected(store, selection, slot)

	const follow = (link: number): boolean => {
		const known = reachesOutside.get(link)

		if (known !== undefined) {
			return known
		}

		// A cycle ends inside.
		reachesOutside.set(link, false)

		const targetIndex = store.link(link)?.targetIndex ?? -1
		const target = targetIndex < 0 ? -1 : store.slotOfIndex(targetIndex)
		let outside = false

		if (target >= 0 && store.skip(target) === 0) {
			if (!isBelow(store, store.parent(target), baseDir)) {
				// Where the chain goes on from there is for a resolve from a higher base to tell.
				outside = true
				outsideBase.add(targetIndex)
			} else {
				if (!covered(target)) {
					added.add(target)
					emit(target)
					coverEntry(target)
					linkTargetsAdded += 1
				}

				outside = store.kind(target) === ENTRY_KIND.hardlink && follow(target)
			}
		}

		reachesOutside.set(link, outside)

		return outside
	}

	// coverEntry appends the links an added target brings in; an array's iterator reaches those too.
	for (const link of links) {
		if (follow(link) && !added.has(link)) {
			outsideLinks.push(link)
		}
	}

	// Ascending, so the SDK gets the same call for the same selection.
	indexes.sort((a, b) => a - b)

	return { kind: "entries", indexes, files, bytes, linkTargetsAdded, outsideBase: [...outsideBase], outsideLinks, encrypted }
}

function depthOf(store: EntryStore, dir: number): number {
	let depth = 0

	for (let node = store.dirParent(dir); node >= 0; node = store.dirParent(node)) {
		depth += 1
	}

	return depth
}

// The nearest directory holding the base and every target outside it: "extract from there instead".
export function commonBaseDir(store: EntryStore, baseDir: number, outsideBase: readonly number[]): number {
	let common = baseDir

	for (const index of outsideBase) {
		const slot = store.slotOfIndex(index)

		if (slot < 0) {
			continue
		}

		let other = store.parent(slot)
		let commonDepth = depthOf(store, common)
		let otherDepth = depthOf(store, other)

		while (commonDepth > otherDepth) {
			common = store.dirParent(common)
			commonDepth -= 1
		}

		while (otherDepth > commonDepth) {
			other = store.dirParent(other)
			otherDepth -= 1
		}

		while (common !== other) {
			common = store.dirParent(common)
			other = store.dirParent(other)
		}
	}

	return common
}

// Encrypted entries are in the selection and no password has been accepted for them yet.
export function selectionNeedsPassword(resolved: ResolvedSelection, summary: ListSummary | null, password: string | undefined): boolean {
	if (password !== undefined || summary === null || (summary.password !== "required" && summary.password !== "wrong")) {
		return false
	}

	return resolved.kind === "all" || resolved.encrypted
}

// "Next to the archive" needs its own directory; any other target names its destination.
export function targetDestination(
	source: ArchiveSource,
	target: ExtractTarget,
	rootName: string,
	nameOf: (uuid: string) => string | undefined = cachedDirectoryName
): JobDestination | null {
	if (target.type === "directory") {
		return target.destination
	}

	if (source.ownParent === undefined) {
		return null
	}

	return source.ownParent === null
		? { uuid: null, name: rootName }
		: { uuid: source.ownParent, name: nameOf(source.ownParent) ?? i18n.t("drive:driveMoveDestinationFallback") }
}

export interface ExtractRequestInput {
	source: ArchiveSource
	info: ArchiveNameInfo
	summary: ListSummary | null
	target: ExtractTarget
	// targetDestination's answer.
	destination: JobDestination
}

type ExtractRequest = Omit<ExtractJobRequest, "id">

function formatOf(input: ExtractRequestInput): ArchiveFormat | null {
	return input.summary?.format ?? input.info.format
}

// What every browser extract shares: macOS metadata skipped as the listing skipped it (so the greyed
// rows are what stays behind), and the archive kept.
function baseRequest(
	input: ExtractRequestInput
): Pick<ExtractRequest, "archive" | "destination" | "skipMacMetadata" | "dispose" | "formatHint"> {
	return {
		archive: { file: input.source.file, uuid: input.source.uuid, name: input.source.name },
		destination: input.destination,
		skipMacMetadata: true,
		dispose: null,
		formatHint: formatOf(input)?.type ?? null
	}
}

// The listing's format decides over the name's guess.
function rootFields(input: ExtractRequestInput, folderName: string | undefined): Pick<ExtractRequest, "root" | "rowName" | "glyph"> {
	return extractRequestShape(
		{ format: formatOf(input), defaultName: input.info.defaultName },
		input.source.name,
		input.target.type === "beside" ? "destination" : "newFolder",
		folderName
	)
}

// "Extract all": the whole archive, the SDK naming a new directory after it.
export function fullExtractRequest(input: ExtractRequestInput): ExtractRequest {
	return {
		...baseRequest(input),
		...rootFields(input, undefined),
		calls: [{ type: "all" }],
		basis: { type: "archiveRead" }
	}
}

// The selection below `baseDir`, its paths taken relative to it. A new directory is named after the base
// directory, or after the archive at its root.
export function selectionExtractRequest(
	input: ExtractRequestInput,
	store: EntryStore,
	resolved: Extract<ResolvedSelection, { kind: "entries" }>,
	baseDir: number
): ExtractRequest {
	const archive = input.source.uuid

	return {
		...baseRequest(input),
		...rootFields(input, baseDir === 0 ? input.info.defaultName : store.dirName(baseDir)),
		calls: [
			{
				type: "entries",
				entries: resolved.indexes.map(index => ({ archive, index })),
				base: store.dirPath(baseDir),
				destination: { uuid: input.destination.uuid }
			}
		],
		basis: { type: "planned", bytes: resolved.bytes, files: resolved.files }
	}
}

// Starts it with the password the listing accepted, so it is never asked for twice.
export function startBrowserExtract(session: Pick<ListingSession, "password">, request: ExtractRequest): string {
	return startExtractWithCard(request, session.password())
}
