import sqlite from "@/lib/sqlite"
import { type CameraUploadSkipReason } from "@/features/cameraUpload/cameraUpload"

export const BACKGROUND_RUN_LOG_KEY = "backgroundRunLog"
export const BACKGROUND_RUN_LOG_MAX_ENTRIES = 20

// Furthest stage the run ENTERED. "done" means the run completed everything it intended
// (including intended early ends like offline-disabled or budget-consumed); a cancelled
// run keeps the phase it was cancelled in, an unauthed/broken run stays at "setup".
export type BackgroundRunPhase = "setup" | "camera" | "offline" | "notesOffline" | "done"

export type BackgroundRunLogEntry = {
	v: 1
	startedAt: number
	finishedAt: number
	phase: BackgroundRunPhase
	cancelled: boolean
	result: "success" | "failed"
	errorMessage?: string
	/**
	 * What the camera phase actually did.
	 *
	 * Without these a run that skipped at a config/connectivity/power gate was recorded identically
	 * to one that uploaded — both "success", both phase "done" — so a field report of "background
	 * upload never works" had no evidence to distinguish "the OS never ran us", "we ran and were
	 * gated", and "we ran and there was nothing to upload".
	 */
	cameraUploaded?: number
	cameraSkipReason?: CameraUploadSkipReason
}

// Field diagnosability for background runs (audit B6, 2026-06-11): release builds strip
// console.log/info/debug, and the value the JS task RETURNS never reaches either OS scheduler —
// expo-background-task reports success for any run that completes and returns (only an iOS
// expiry or an Android infra exception report failure), so our own Success/Failed distinction is
// invisible outside this row. Warn/error still reach the NDJSON log, but a quiet run writes none,
// which makes this capped kv row the only GUARANTEED trace a run leaves. One awaited kvAsync write
// per run, never debounced, so it lands before a headless process is suspended. Read surface for
// debugging / a future "last background sync" settings row.
const backgroundRunLog = {
	async append(entry: BackgroundRunLogEntry): Promise<void> {
		const existing = await sqlite.kvAsync.get<BackgroundRunLogEntry[]>(BACKGROUND_RUN_LOG_KEY)
		const entries = Array.isArray(existing) ? existing : []

		entries.push(entry)

		await sqlite.kvAsync.set(BACKGROUND_RUN_LOG_KEY, entries.slice(-BACKGROUND_RUN_LOG_MAX_ENTRIES))
	},
	async list(): Promise<BackgroundRunLogEntry[]> {
		const entries = await sqlite.kvAsync.get<BackgroundRunLogEntry[]>(BACKGROUND_RUN_LOG_KEY)

		return Array.isArray(entries) ? entries : []
	}
}

export default backgroundRunLog
