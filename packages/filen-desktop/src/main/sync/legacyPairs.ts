import { type } from "arktype"
import type { DesktopSyncMode } from "@filen/shared/desktop"
import { localPathSchema } from "../../shared/nativeProtocol.ts"
import { codedError, errorCode } from "../atomicFile.ts"
import type { FirstRunDeps } from "./firstRun.ts"
import { basename, rootKey } from "./mirror.ts"
import type { ShellPair } from "./store.ts"

// The old client's (3.0.53) sync pairs, PLAN §6 step 6: its config, and each pair's ignore file. Its engine state under
// userData/sync is never read; a migrated pair's first run proves what is in sync from both sides (see firstRun.ts).

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

// `remoteParentUUID` is, despite its name, the pair's remote directory itself. Early builds stored no
// `localTrashDisabled` (nor, earlier still, `excludeDotFiles`); the old client read every switch by truthiness.
const pairSchema = type({
	"name?": "unknown",
	uuid: "string.uuid",
	localPath: localPathSchema,
	remoteParentUUID: "string.uuid",
	mode: type.enumerated(...(Object.keys(MODES) as (keyof typeof MODES)[])),
	"excludeDotFiles?": "unknown",
	"paused?": "unknown",
	"localTrashDisabled?": "unknown",
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
	// Entries that are not a pair.
	dropped: number
	// Pairs another one with the same uuid or the same directories came before (the first is kept).
	merged: number
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
	let merged = 0

	for (const entry of config.syncPairs) {
		const pair = pairSchema(entry)

		if (pair instanceof type.errors) {
			dropped++

			continue
		}

		const keys = [pair.uuid.toLowerCase(), rootKey(pair.localPath, pair.remoteParentUUID)]

		if (keys.some(key => seen.has(key))) {
			merged++

			continue
		}

		for (const key of keys) {
			seen.add(key)
		}

		pairs.push({
			uuid: pair.uuid,
			name: typeof pair.name === "string" ? pair.name : "",
			localPath: pair.localPath,
			remoteRoot: pair.remoteParentUUID,
			mode: mapLegacyMode(pair.mode),
			excludeDotFiles: Boolean(pair.excludeDotFiles),
			paused: Boolean(pair.paused),
			localTrashDisabled: Boolean(pair.localTrashDisabled)
		})
	}

	return { enabled: config.enabled, pairs, dropped, merged }
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

// The old client's built-in ignores the engine's defaults lack. The old trash needs no rule (the engine reserves it).
export const LEGACY_BUILTIN_RULES = ["*.tmp", "*.temp", "*.ffs_tmp", "*.temporary", "*.~cr", "*.thumbdata", "*.crswap", "ntuser.dat"]

// The device-wide user ignore after the import: the old client's built-ins, whenever it had a pair.
export function legacyUserIgnore(pairs: readonly LegacyPair[], existing: string): string {
	return pairs.length === 0
		? existing
		: withRules(
				existing,
				LEGACY_BUILTIN_RULES.map(rule => [rule])
			)
}

// The lines of the old per-pair ignore file (trimmed, as the old client read them), then the dot-file rules (last, so the rule file itself stays synced);
// null when there are none.
export function legacyPairRules(pair: LegacyPair, ignorer: string | null): string[] | null {
	const lines = (ignorer ?? "")
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line.length > 0)
	const rules = pair.excludeDotFiles ? [...lines, ...DOT_FILE_RULES] : lines

	return rules.length === 0 ? null : rules
}

const NAME_MAX = 1024

// The shell's records of the imported pairs, before the engine holds any: the attach step (firstRun.ts) adds them.
// Each starts waiting for its directory; a pair the old client kept from running stays paused. `ignorers` holds each
// pair's old ignore file by uuid.
export function legacyRecords(imported: LegacyImport, ignorers: ReadonlyMap<string, string>, now: number): ShellPair[] {
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
		legacyRules: legacyPairRules(pair, ignorers.get(pair.uuid) ?? null),
		notices: [],
		rootProblem: null,
		holds: [],
		wholeDriveConfirmed: false,
		info: pair.localTrashDisabled ? ["localTrashNowOn"] : [],
		createdAt: now
	}))
}

export interface LegacySyncDeps extends FirstRunDeps {
	// The old client's ignore file of a pair (userData/sync/ignorer/v1/<uuid>/filenIgnore); null when it has none or it
	// is not UTF-8 text.
	legacyIgnorer(uuid: string): Promise<string | null>
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

		const ignorers = new Map<string, string>()

		for (const pair of imported.pairs) {
			const text = await deps.legacyIgnorer(pair.uuid)

			if (text !== null) {
				ignorers.set(pair.uuid, text)
			}
		}

		const records = legacyRecords(imported, ignorers, deps.now())
		const { dropped, merged } = imported

		await deps.store.update(state => {
			const known = new Set(state.pairs.flatMap(pair => (pair.legacyUuid === null ? [] : [pair.legacyUuid.toLowerCase()])))

			return {
				...state,
				pairs: [...state.pairs, ...records.filter(pair => !known.has(pair.legacyUuid?.toLowerCase() ?? ""))],
				legacyApplied: true,
				importNote: dropped + merged > 0 ? { dropped, merged } : null
			}
		})
		deps.log.info(
			`sync: imported ${String(records.length)} pairs of the previous app (${String(dropped)} invalid, ${String(merged)} duplicates)`
		)
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
