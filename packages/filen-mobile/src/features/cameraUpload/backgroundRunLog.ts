import sqlite from "@/lib/sqlite"

export const BACKGROUND_RUN_LOG_KEY = "backgroundRunLog"
export const BACKGROUND_RUN_LOG_MAX_ENTRIES = 20

// Furthest stage the run ENTERED. "done" means the run completed everything it intended
// (including intended early ends like offline-disabled or budget-consumed); a cancelled
// run keeps the phase it was cancelled in, an unauthed/broken run stays at "setup".
export type BackgroundRunPhase = "setup" | "camera" | "offline" | "done"

export type BackgroundRunLogEntry = {
	v: 1
	startedAt: number
	finishedAt: number
	phase: BackgroundRunPhase
	cancelled: boolean
	result: "success" | "failed"
	errorMessage?: string
}

// Field diagnosability for background runs (audit B6, 2026-06-11): release builds no-op
// console.* and BOTH OS schedulers discard the task's returned result (expo-background-task
// always reports success to the OS) — this capped kv row is the only trace a run leaves.
// One awaited kvAsync write per run, never debounced, so it lands before a headless process
// is suspended. Read surface for debugging / a future "last background sync" settings row.
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
