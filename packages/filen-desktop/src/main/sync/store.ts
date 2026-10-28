import { type } from "arktype"
import type { DesktopSyncMode, DesktopSyncNotice, DesktopSyncReview, DesktopSyncReviewFinding } from "@filen/shared/desktop"
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

export type LegacyDotFiles = "device" | "pair"

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
	// The old client hid this pair's dot files, now through the device-wide ignore or the pair's own root .filenignore.
	legacyDotFiles: LegacyDotFiles | null
	notices: DesktopSyncNotice[]
	// Epoch ms.
	createdAt: number
}

export interface ShellSyncState {
	version: 1
	pairs: ShellPair[]
	// The old client's sync config was applied for this user.
	legacyApplied: boolean
}

const EMPTY: ShellSyncState = { version: 1, pairs: [], legacyApplied: false }

const findingSchema = pinned<DesktopSyncReviewFinding>()(
	type.enumerated("uploads", "downloads", "conflicts", "heldDeletions", "refused", "unconverged", "overwrites")
)

// Each one stands for an engine refusal: such a pair is never added, and dismissing the notice removes it.
export const noticeSchema = pinned<DesktopSyncNotice>()(
	type.enumerated("refusedLocalRoot", "refusedRemoteMissing", "refusedLocalOverlap", "refusedRemoteOverlap")
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
		legacyDotFiles: type("'device' | 'pair' | null"),
		notices: noticeSchema.array(),
		createdAt: "number.integer >= 0",
		"+": "delete"
	})
)

const earlierSchema = type({ state: "unknown", notices: "string[]", review: type({ findings: "string[]" }).or("null") })

// What earlier builds wrote and this one no longer does: the old trash notice (under either of its names), review
// findings no longer given, and an account-root pair the engine could not sync then, which now waits for its directory
// like any other.
const DROPPED_NOTICES: ReadonlySet<string> = new Set(["localTrashMoved", "localTrashDropped", "accountRootUnsupported"])
const DROPPED_FINDINGS: ReadonlySet<string> = new Set(["newlySynced", "dotFilesPerPair"])

function withCurrentFields(entry: unknown): unknown {
	const pair = earlierSchema(entry)

	if (
		pair instanceof type.errors ||
		(!pair.notices.some(notice => DROPPED_NOTICES.has(notice)) &&
			!(pair.review?.findings.some(finding => DROPPED_FINDINGS.has(finding)) ?? false))
	) {
		return entry
	}

	return {
		...pair,
		state: pair.state === "unsupported" && pair.notices.includes("accountRootUnsupported") ? "waitingForRoot" : pair.state,
		notices: pair.notices.filter(notice => !DROPPED_NOTICES.has(notice)),
		review:
			pair.review === null
				? null
				: { ...pair.review, findings: pair.review.findings.filter(finding => !DROPPED_FINDINGS.has(finding)) }
	}
}

const fileSchema = type({ version: "1", pairs: "unknown[]", legacyApplied: "boolean", "+": "delete" })

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
		const pair = shellPairSchema(withCurrentFields(entry))

		if (pair instanceof type.errors) {
			warn("dropping an invalid sync pair record")
		} else {
			pairs.push(pair)
		}
	}

	return { version: 1, pairs, legacyApplied: file.legacyApplied }
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
