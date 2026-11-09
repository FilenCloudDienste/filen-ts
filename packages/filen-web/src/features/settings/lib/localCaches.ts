import { THUMB_DIR_ROOT } from "@/features/drive/lib/thumbnails.logic"
import { wipeThumbnailStore } from "@/features/drive/lib/thumbCache"
import { ART_DIR_ROOT } from "@/features/videos/lib/artStore.logic"
import { wipeArtStore } from "@/features/videos/lib/artStore"
import { INDEX_DIR_ROOT } from "@/features/videos/lib/indexStore.logic"
import { wipeVideoIndexStore } from "@/features/videos/lib/indexStore"
import { VIDEO_CACHE_KV_PREFIXES } from "@/features/videos/lib/cacheKeys.logic"
import { TRACK_TAGS_KV_PREFIX } from "@/features/audio/lib/trackTags.logic"
import { resetTrackTags } from "@/features/audio/store/useTrackTagsStore"
import { MODEL_LOCK, MODELS_DIRECTORY, deleteModels } from "@/features/assistant/runtime/modelStore"
import { removeAssistantModel } from "@/features/assistant/store/assistantSession"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { callMounts } from "@/features/mounts/lib/mountsActions"
import { PERSIST_FAMILY } from "@/queries/persist"
import { kvDeletePrefix, kvPrefixBytes, vacuumDatabase } from "@/lib/storage/adapter"
import { opfsTreeBytes } from "@/lib/storage/opfs"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"

// The local caches the Storage settings page measures and clears. Every one is rebuilt on demand from the account's
// files; none holds the session, an outbox, history, a preference, sync state, mount credentials or logs. Each clear
// names its rows explicitly (never kvClear, which is sign-out's full wipe).

// In bar and legend order.
export const CACHE_ROWS = ["thumbnails", "videos", "music", "queryCache", "model", "browserCache", "networkDrive"] as const

export type CacheRow = (typeof CACHE_ROWS)[number]

// Every row but the model, which has its own Remove.
export type ClearableRow = Exclude<CacheRow, "model">

// Measured here; the network drive's size arrives with the mounts overview instead.
export type MeasuredRow = Exclude<CacheRow, "networkDrive">

// Everything Clear all takes. The model is never in it: it is gigabytes to fetch again and the user removes it on
// purpose.
export const CLEAR_ALL_ROWS: readonly ClearableRow[] = ["thumbnails", "videos", "music", "queryCache", "browserCache", "networkDrive"]

// Rows that hold data another open tab keeps using from memory (the Videos index and artwork handles, the query
// cache that writes itself back), so a clear is finished only once every tab reloads.
export const RELOAD_ROWS: ReadonlySet<CacheRow> = new Set<CacheRow>(["videos", "queryCache"])

// Rows that exist only in the desktop app.
export const DESKTOP_ROWS: ReadonlySet<CacheRow> = new Set<CacheRow>(["browserCache", "networkDrive"])

// What Clear all runs here: the desktop rows only in the desktop app, and the network drive only with something in
// its cache (a drive never set up has no host to ask, and would only fail).
export function clearAllRows(desktop: boolean, networkDriveBytes: number | null): ClearableRow[] {
	return CLEAR_ALL_ROWS.filter(row => (desktop || !DESKTOP_ROWS.has(row)) && (row !== "networkDrive" || (networkDriveBytes ?? 0) > 0))
}

// Rows whose clear deletes kv rows, after which the database file is compacted.
const KV_ROWS: ReadonlySet<CacheRow> = new Set<CacheRow>(["videos", "music", "queryCache"])

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0)
}

// Bytes on disk, or null when this build's storage leader cannot measure kv rows yet (another tab on an older build).
export async function measureRow(row: MeasuredRow, signal?: AbortSignal): Promise<number | null> {
	switch (row) {
		case "thumbnails":
			return opfsTreeBytes(THUMB_DIR_ROOT, signal)
		case "videos": {
			const [art, index, kv] = await Promise.all([
				opfsTreeBytes(ART_DIR_ROOT, signal),
				opfsTreeBytes(INDEX_DIR_ROOT, signal),
				kvPrefixBytes(VIDEO_CACHE_KV_PREFIXES)
			])

			return art + index + sum(kv ?? [])
		}
		case "music": {
			const bytes = await kvPrefixBytes([TRACK_TAGS_KV_PREFIX])

			return bytes === null ? null : sum(bytes)
		}
		case "queryCache": {
			const bytes = await kvPrefixBytes([PERSIST_FAMILY])

			return bytes === null ? null : sum(bytes)
		}
		case "model":
			return opfsTreeBytes([MODELS_DIRECTORY], signal)
		case "browserCache": {
			const app = desktopBridge()?.app

			return app === undefined ? null : app.browserCacheSize()
		}
	}
}

// What the origin uses in all, the measured rows and everything no row names (the database file, the old app's
// leftovers, a part-downloaded model of another build).
export async function originUsage(): Promise<number | null> {
	const { usage } = await navigator.storage.estimate()

	return usage ?? null
}

export type ClearOutcome = { kind: "cleared" } | { kind: "skipped"; reason: "uploadsPending" }

export class CacheClearError extends Error {
	public readonly row: CacheRow

	public constructor(row: CacheRow, cause: unknown) {
		super(`clearing ${row} failed`, { cause })
		this.name = "CacheClearError"
		this.row = row
	}
}

async function settleAll(work: readonly Promise<unknown>[]): Promise<void> {
	const failed = (await Promise.allSettled(work)).find(outcome => outcome.status === "rejected")

	if (failed !== undefined) {
		throw failed.reason
	}
}

async function clearRowNow(row: ClearableRow): Promise<ClearOutcome> {
	switch (row) {
		case "thumbnails":
			await wipeThumbnailStore()
			break
		case "videos":
			await settleAll([wipeArtStore(), wipeVideoIndexStore(), ...VIDEO_CACHE_KV_PREFIXES.map(prefix => kvDeletePrefix(prefix))])
			break
		case "music":
			await kvDeletePrefix(TRACK_TAGS_KV_PREFIX)
			// This tab's in-memory copy would keep showing the tags; other tabs keep theirs but never write it back.
			resetTrackTags()
			break
		case "queryCache":
			await kvDeletePrefix(PERSIST_FAMILY)
			break
		case "browserCache": {
			const app = desktopBridge()?.app

			if (app === undefined) {
				throw new Error("The browser cache needs the desktop app")
			}

			await app.clearBrowserCache()
			break
		}
		case "networkDrive": {
			const mounts = desktopBridge()?.mounts

			if (mounts === undefined) {
				throw new Error("The network drive needs the desktop app")
			}

			// The shell refuses while uploads wait, decided at the moment it runs; no check here could race it.
			const result = await callMounts(() => mounts.clearCache())

			if (!result.ok) {
				if (result.error.code === "uploadsPending") {
					return { kind: "skipped", reason: "uploadsPending" }
				}

				throw new Error(`network drive cache: ${result.error.code}`)
			}

			break
		}
	}

	return { kind: "cleared" }
}

// Hands the space deleted rows left back to the file system. The rows are already gone, so a failure here is only
// logged.
async function compactDatabase(): Promise<void> {
	try {
		await vacuumDatabase()
	} catch (e) {
		log.warn("storage.caches", "vacuum failed", e)
	}
}

// Clears one row. Throws CacheClearError on failure.
export async function clearRow(row: ClearableRow): Promise<ClearOutcome> {
	let outcome: ClearOutcome

	try {
		outcome = await clearRowNow(row)
	} catch (e) {
		log.error("storage.caches", `clearing ${row} failed`, e)

		throw new CacheClearError(row, e)
	}

	if (KV_ROWS.has(row)) {
		await compactDatabase()
	}

	return outcome
}

export interface ClearAllResult {
	cleared: CacheRow[]
	skipped: CacheRow[]
	failed: CacheRow[]
}

// Every row of `rows` at once, each to its end whatever the others do, then one compaction.
export async function clearRows(rows: readonly ClearableRow[]): Promise<ClearAllResult> {
	const outcomes = await Promise.allSettled(rows.map(row => clearRowNow(row)))
	const result: ClearAllResult = { cleared: [], skipped: [], failed: [] }

	outcomes.forEach((outcome, index) => {
		const row = rows[index]

		if (row === undefined) {
			return
		}

		if (outcome.status === "rejected") {
			log.error("storage.caches", `clearing ${row} failed`, outcome.reason)
			result.failed.push(row)
		} else if (outcome.value.kind === "skipped") {
			result.skipped.push(row)
		} else {
			result.cleared.push(row)
		}
	})

	if (result.cleared.some(row => KV_ROWS.has(row))) {
		await compactDatabase()
	}

	return result
}

export class ModelInUseError extends Error {
	public constructor() {
		super("The model is in use in another tab")
		this.name = "ModelInUseError"
	}
}

// Removes the downloaded model through the runtime, which first stops a download and unloads it. A runtime that
// found the device unable to run the model never looked at the disk, so a model left from before is removed directly,
// under the lock every tab takes to run it.
export async function removeModel(): Promise<void> {
	const state = useAssistantStore.getState().modelState.kind

	if (state !== "unavailable" && state !== "checking") {
		await removeAssistantModel()

		return
	}

	const removed = await navigator.locks.request(MODEL_LOCK, { ifAvailable: true }, async lock => {
		if (lock === null) {
			return false
		}

		await deleteModels()

		return true
	})

	if (!removed) {
		throw new ModelInUseError()
	}
}
