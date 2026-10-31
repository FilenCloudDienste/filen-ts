import { type } from "arktype"
import type {
	DesktopSyncHold,
	DesktopSyncImportNote,
	DesktopSyncInfoNotice,
	DesktopSyncMode,
	DesktopSyncNotice,
	DesktopSyncReview,
	DesktopSyncReviewFinding,
	DesktopSyncRootProblem
} from "@filen/shared/desktop"
import { localPathSchema, pairIdSchema, pinned, planSummarySchema, syncModeSchema } from "../../shared/nativeProtocol.ts"
import { type AtomicFile, errorCode } from "../atomicFile.ts"
import { serialQueue } from "../../shared/serial.ts"

// What the shell keeps about each sync pair beside the engine: the name, the review and notices, the old client's
// pair uuid, and pairs the engine does not hold. It is also the recovery copy of the engine's pairs, which live in
// the baseline DB and go with it when a schema change forces a reset. The engine is the source of truth whenever it
// is open (see reconcileMirror).
// `preparing`: a migrated pair the engine holds paused until its first run may start; its `paused` is what the user
// had, not the engine's.
export type ShellPairState = "active" | "preparing" | "review" | "waitingForRoot" | "unsupported"

export interface ShellPair {
	// null while the engine does not hold the pair.
	pairId: string | null
	name: string
	localRoot: string
	remoteRoot: string
	mode: DesktopSyncMode
	paused: boolean
	state: ShellPairState
	review: DesktopSyncReview | null
	legacyUuid: string | null
	// The rules the pair's root .filenignore must hold before its first pass (the old client's dot-file switch and its
	// per-pair ignore file); null once written, and for pairs not moved from it.
	legacyRules: string[] | null
	notices: DesktopSyncNotice[]
	// Why the engine may not have the local directory (with the refusedLocalRoot notice).
	rootProblem: DesktopSyncRootProblem | null
	holds: DesktopSyncHold[]
	// The user started this pair of the whole drive anyway.
	wholeDriveConfirmed: boolean
	info: DesktopSyncInfoNotice[]
	// Epoch ms.
	createdAt: number
}

export interface ShellSyncState {
	version: 1
	pairs: ShellPair[]
	// The old client's sync config was applied for this user.
	legacyApplied: boolean
	// What the import could not carry over, until dismissed.
	importNote: DesktopSyncImportNote | null
}

const EMPTY: ShellSyncState = { version: 1, pairs: [], legacyApplied: false, importNote: null }

const findingSchema = pinned<DesktopSyncReviewFinding>()(
	type.enumerated("uploads", "downloads", "conflicts", "heldDeletions", "refused", "unconverged", "overwrites")
)

// Each one stands for an engine refusal: such a pair is never added, and dismissing the notice removes it.
export const noticeSchema = pinned<DesktopSyncNotice>()(
	type.enumerated("refusedLocalRoot", "refusedRemoteMissing", "refusedLocalOverlap", "refusedRemoteOverlap", "refusedModeConflict")
)

export const holdSchema = pinned<DesktopSyncHold>()(
	type.enumerated("ruleFileUnwritable", "ruleFileUndecodable", "driveRoot", "cloudListingSlow")
)

export const infoNoticeSchema = pinned<DesktopSyncInfoNotice>()(type.enumerated("localTrashNowOn"))

const rootProblemSchema = pinned<DesktopSyncRootProblem>()(
	type.enumerated(
		"notDirectory",
		"notWritable",
		"filesystemRoot",
		"homeDirectory",
		"appData",
		"temporary",
		"insidePair",
		"containsPair",
		"insideMount",
		"containsMount"
	)
)

const shellPairSchema = pinned<ShellPair>()(
	type({
		pairId: pairIdSchema.or("null"),
		name: "0 < string <= 1024",
		localRoot: localPathSchema,
		remoteRoot: "string.uuid",
		mode: syncModeSchema,
		paused: "boolean",
		state: "'active' | 'preparing' | 'review' | 'waitingForRoot' | 'unsupported'",
		review: type({
			reason: "'migrated' | 'baselineReset'",
			findings: findingSchema.array(),
			summary: planSummarySchema.or("null"),
			"+": "delete"
		}).or("null"),
		legacyUuid: type("string.uuid").or("null"),
		legacyRules: type("string[]").or("null"),
		notices: noticeSchema.array(),
		rootProblem: rootProblemSchema.or("null"),
		holds: holdSchema.array(),
		wholeDriveConfirmed: "boolean",
		info: infoNoticeSchema.array(),
		createdAt: "number.integer >= 0",
		"+": "delete"
	})
)

const fileSchema = type({
	version: "1",
	pairs: "unknown[]",
	legacyApplied: "boolean",
	importNote: type({ dropped: "number.integer >= 0", merged: "number.integer >= 0", "+": "delete" }).or("null"),
	"+": "delete"
})

// A missing or unreadable file is empty; a pair that does not validate is dropped alone, so one bad entry never costs
// the others their names.
export function parseSyncState(data: string | null, warn: (message: string) => void): ShellSyncState {
	if (data === null) {
		return EMPTY
	}

	let json: unknown

	try {
		json = JSON.parse(data)
	} catch {
		warn("sync pair store is not JSON; starting empty")

		return EMPTY
	}

	const file = fileSchema(json)

	if (file instanceof type.errors) {
		warn("sync pair store is invalid; starting empty")

		return EMPTY
	}

	const pairs: ShellPair[] = []

	for (const entry of file.pairs) {
		const pair = shellPairSchema(entry)

		if (pair instanceof type.errors) {
			warn("dropping an invalid sync pair record")
		} else {
			pairs.push(pair)
		}
	}

	return { version: 1, pairs, legacyApplied: file.legacyApplied, importNote: file.importNote }
}

// The remote roots of the pairs that must not run when the host starts: in review or preparing, the engine's id known
// or not (a crash between adding a pair to the engine, which adds it unpaused, and pausing it leaves no id here).
export function heldRemotes(state: ShellSyncState): string[] {
	return state.pairs.filter(pair => pair.state === "preparing" || pair.state === "review").map(pair => pair.remoteRoot)
}

export interface SyncStore {
	get(): ShellSyncState
	// Applies `change` to the state in effect when its turn comes and resolves with the stored result. A failed write
	// rejects and keeps the state as it was.
	update(change: (state: ShellSyncState) => ShellSyncState): Promise<ShellSyncState>
	hasPairs(): boolean
}

// `<dir>/shell.json` beside the user's engine DBs; the caller creates the directory. Read once, served from memory.
// Writes run one at a time (they share the file's temp sibling).
export async function loadSyncStore(file: AtomicFile, warn: (message: string) => void): Promise<SyncStore> {
	let current = EMPTY
	const serial = serialQueue()

	try {
		current = parseSyncState((await file.read())?.toString("utf8") ?? null, warn)
	} catch (error) {
		warn(`sync pair store unreadable: ${errorCode(error)}`)
	}

	return {
		get: () => current,
		update: change =>
			serial(async () => {
				const next = change(current)

				if (next !== current) {
					await file.write(Buffer.from(JSON.stringify(next)))
					current = next
				}

				return current
			}),
		hasPairs: () => current.pairs.length > 0
	}
}
