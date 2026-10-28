import { type } from "arktype"
import type { DesktopSyncMode } from "@filen/shared/desktop"
import { localPathSchema } from "../../shared/nativeProtocol.ts"
import { codedError, errorCode } from "../atomicFile.ts"
import type { FirstRunDeps } from "./firstRun.ts"
import { basename } from "./mirror.ts"
import type { ShellPair } from "./store.ts"

// The old client's (3.0.53) sync pairs, PLAN §6 step 6: only its config. Its engine state under userData/sync is never
// read; a migrated pair's first run proves what is in sync from both sides (see firstRun.ts).

const MODES = {
	twoWay: "twoWay",
	localToCloud: "localToRemote",
	cloudToLocal: "remoteToLocal",
	localBackup: "localBackup",
	cloudBackup: "remoteBackup"
} as const satisfies Record<string, DesktopSyncMode>

export function mapLegacyMode(mode: keyof typeof MODES): DesktopSyncMode {
	return MODES[mode]
}

const configSchema = type({ enabled: "boolean", syncPairs: "unknown[]", "+": "delete" })

// `remoteParentUUID` is, despite its name, the pair's remote directory itself.
const pairSchema = type({
	name: "string",
	uuid: "string.uuid",
	localPath: localPathSchema,
	remoteParentUUID: "string.uuid",
	mode: type.enumerated(...(Object.keys(MODES) as (keyof typeof MODES)[])),
	excludeDotFiles: "boolean",
	paused: "boolean",
	localTrashDisabled: "boolean",
	"+": "delete"
})

export interface LegacyPair {
	uuid: string
	name: string
	localPath: string
	remoteRoot: string
	mode: DesktopSyncMode
	excludeDotFiles: boolean
	paused: boolean
	localTrashDisabled: boolean
}

export interface LegacyImport {
	// The old client's sync switch: off kept every pair from running.
	enabled: boolean
	pairs: LegacyPair[]
	// Entries that are not a pair (counted for the log; never named).
	dropped: number
}

// The user's effective old sync config (effectiveConfig), null when there is none to import.
export function legacySyncImport(effective: unknown): LegacyImport | null {
	const config = configSchema(effective)

	if (config instanceof type.errors) {
		return null
	}

	const pairs: LegacyPair[] = []
	const seen = new Set<string>()
	let dropped = 0

	for (const entry of config.syncPairs) {
		const pair = pairSchema(entry)

		if (pair instanceof type.errors || seen.has(pair.uuid.toLowerCase())) {
			dropped++

			continue
		}

		seen.add(pair.uuid.toLowerCase())
		pairs.push({
			uuid: pair.uuid,
			name: pair.name,
			localPath: pair.localPath,
			remoteRoot: pair.remoteParentUUID,
			mode: mapLegacyMode(pair.mode),
			excludeDotFiles: pair.excludeDotFiles,
			paused: pair.paused,
			localTrashDisabled: pair.localTrashDisabled
		})
	}

	return { enabled: config.enabled, pairs, dropped }
}

// Dot files hidden, rule files still synced (the engine reads them as rules either way).
export const DOT_FILE_RULES = [".*", "!/.filenignore"] as const

// `text` with each block's lines appended where missing. Rules later in a block depend on the earlier ones (a
// negation must follow what it negates), so from a block's first missing line on the rest is appended too. The
// user's own lines are never dropped or reordered.
export function withRules(text: string, blocks: readonly (readonly string[])[]): string {
	const present = new Set(text.split(/\r?\n/).map(line => line.trim()))
	const added: string[] = []

	for (const block of blocks) {
		const first = block.findIndex(line => !present.has(line))

		if (first !== -1) {
			added.push(...block.slice(first))
		}
	}

	if (added.length === 0) {
		return text
	}

	const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n"

	return `${text}${separator}${added.join("\n")}\n`
}

// The device-wide user ignore after the import: dot files when every pair hid them (otherwise each such pair gets its
// own rule file). The old trash needs no rule (the engine reserves it); the old client's other built-in patterns are
// not carried over.
export function legacyUserIgnore(pairs: readonly LegacyPair[], existing: string): string {
	return dotFilesUniform(pairs) ? withRules(existing, [DOT_FILE_RULES]) : existing
}

function dotFilesUniform(pairs: readonly LegacyPair[]): boolean {
	return pairs.length > 0 && pairs.every(pair => pair.excludeDotFiles)
}

const NAME_MAX = 1024

// The shell's records of the imported pairs, before the engine holds any: the attach step (firstRun.ts) adds them.
// Each starts waiting for its directory; a pair the old client kept from running stays paused.
export function legacyRecords(imported: LegacyImport, now: number): ShellPair[] {
	const uniform = dotFilesUniform(imported.pairs)

	return imported.pairs.map(pair => ({
		pairId: null,
		name: pair.name.trim().slice(0, NAME_MAX) || basename(pair.localPath).slice(0, NAME_MAX),
		localRoot: pair.localPath,
		remoteRoot: pair.remoteRoot,
		mode: pair.mode,
		paused: pair.paused || !imported.enabled,
		state: "waitingForRoot",
		review: null,
		legacyUuid: pair.uuid,
		legacyDotFiles: pair.excludeDotFiles ? (uniform ? "device" : "pair") : null,
		notices: [],
		createdAt: now
	}))
}

export interface LegacySyncDeps extends FirstRunDeps {
	stash: {
		// The user's effective old sync config; undefined when none is waiting.
		pending(): Promise<unknown>
		consume(): Promise<void>
	}
}

// Once per user, on a host `ready` while a sync stash waits: the device-wide ignore first (before any pair can be
// planned), then a record of every pair, then the stash is consumed. A crash anywhere reruns it: lines and pairs
// already there (by the old uuid) are not added twice. The records are attached to the engine afterwards.
export async function applyLegacySync(deps: LegacySyncDeps): Promise<void> {
	const effective = await deps.stash.pending()

	if (effective === undefined) {
		return
	}

	const imported = deps.store.get().legacyApplied ? null : legacySyncImport(effective)

	if (imported !== null) {
		const current = await deps.call("userIgnore", {})

		if (!current.ok) {
			throw codedError(`user ignore unreadable: ${current.error.code}`)
		}

		const text = legacyUserIgnore(imported.pairs, current.value)

		if (text !== current.value) {
			const set = await deps.call("setUserIgnore", { text })

			if (!set.ok) {
				throw codedError(`user ignore not set: ${set.error.code}`)
			}
		}

		const records = legacyRecords(imported, deps.now())

		await deps.store.update(state => {
			const known = new Set(state.pairs.flatMap(pair => (pair.legacyUuid === null ? [] : [pair.legacyUuid.toLowerCase()])))

			return {
				...state,
				pairs: [...state.pairs, ...records.filter(pair => !known.has(pair.legacyUuid?.toLowerCase() ?? ""))],
				legacyApplied: true
			}
		})
		deps.log.info(`sync: imported ${String(records.length)} pairs of the previous app (${String(imported.dropped)} invalid)`)

		const trashed = imported.pairs.filter(pair => !pair.localTrashDisabled).length

		// The engine moves each such pair's .filen.trash.local into the pair's bin on its first sync.
		if (trashed > 0) {
			deps.log.info(`sync: ${String(trashed)} of them used the previous app's local trash`)
		}
	} else if (!deps.store.get().legacyApplied) {
		await deps.store.update(state => ({ ...state, legacyApplied: true }))
	}

	try {
		await deps.stash.consume()
	} catch (error) {
		// Applied already (legacyApplied): the next run only consumes.
		deps.log.warn(`sync: the stash was not consumed: ${errorCode(error)}`)
	}
}
