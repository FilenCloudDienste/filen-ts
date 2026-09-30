import { run, Semaphore } from "@filen/shared"
import { onlineManager } from "@tanstack/react-query"
import alerts from "@/lib/alerts"
import sqlite from "@/lib/sqlite"
import logger from "@/lib/logger"

/**
 * Scaffold shared by the persisted outboxes (chats, notes): the pass mutex, the restore gate, the
 * abort controller and the SQLite mirror. Subclasses own the queue shape, the restore merge and the
 * push loop.
 */
export abstract class OutboxSync<S extends object> {
	public readonly sqliteKvKey: string
	protected readonly logScope: string
	protected readonly mutex: Semaphore = new Semaphore(1)
	protected readonly initPromise: Promise<void>
	protected resolveInit!: () => void
	protected abortController: AbortController = new AbortController()
	// Set true by start() (called only from the SyncHost mount). A headless background run never
	// mounts SyncHost, so start() never runs and initPromise never resolves — runPass() guards on
	// this to no-op instead of hanging forever on Promise.all([mutex, initPromise]) (which would
	// hold the mutex and wedge every future pass). Nothing was hydrated to sync without a prior
	// restore anyway; persisted work flushes on the next foreground open.
	private started: boolean = false

	protected constructor({ sqliteKvKey, logScope }: { sqliteKvKey: string; logScope: string }) {
		this.sqliteKvKey = sqliteKvKey
		this.logScope = logScope
		this.initPromise = new Promise(resolve => {
			this.resolveInit = resolve
		})
	}

	public start(): void {
		this.started = true

		this.restoreFromDisk()
	}

	public cancel(): void {
		this.abortController.abort()
		this.abortController = new AbortController()
	}

	// Must call resolveInit() once done, whatever the outcome.
	protected abstract restoreFromDisk(): Promise<void>

	// What of the queue is written to disk.
	protected toPersisted(value: S): S {
		return value
	}

	// M3: reports persistence failure as `false` instead of throwing (it still never
	// throws). Sync-internal callers ignore the return (the next pass re-flushes);
	// COMPONENT call sites must surface a `false` — a failing SQLite write means the
	// user's work survives in memory only and would otherwise die with zero signal.
	public async flushToDisk(value: S): Promise<boolean> {
		await this.initPromise

		const result = await run(async () => {
			const persisted = this.toPersisted(value)

			if (Object.keys(persisted).length === 0) {
				await sqlite.kvAsync.remove(this.sqliteKvKey)

				return
			}

			await sqlite.kvAsync.set(this.sqliteKvKey, persisted)
		})

		if (!result.success) {
			logger.error(this.logScope, "flushToDisk failed; in-flight state not persisted", { error: result.error })
		}

		return result.success
	}

	/**
	 * One pass under the mutex, after the restore. `body` returns the queue to flush, or null to skip
	 * the flush. `afterRun` runs once the pass settles unless it was aborted.
	 */
	protected async runPass(body: (signal: AbortSignal) => Promise<S | null>, afterRun?: () => void): Promise<void> {
		if (!this.started) {
			return
		}

		if (!onlineManager.isOnline()) {
			return
		}

		const signal = this.abortController.signal

		const result = await run(async defer => {
			await Promise.all([this.mutex.acquire(), this.initPromise])

			defer(() => {
				this.mutex.release()
			})

			const next = await body(signal)

			// D2: never flush after an aborted pass. Logout aborts in-flight sync (Phase 2) and
			// later wipes SQLite (Phase 6) — a late flush here would resurrect the previous
			// account's plaintext queue onto disk after the wipe.
			if (next !== null && !signal.aborted) {
				await this.flushToDisk(next)
			}
		})

		if (!signal.aborted) {
			afterRun?.()
		}

		if (!result.success) {
			if (signal.aborted) {
				return
			}

			logger.error(this.logScope, "sync pass failed unexpectedly", { error: result.error })
			alerts.error(result.error)
		}
	}
}
