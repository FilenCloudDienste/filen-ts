import * as Comlink from "comlink"
import { originRanged, originSize, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import { sdkApi } from "@/lib/sdk/client"
import { createOwnedWorker, type OwnedWorker } from "@/lib/workers/ownedWorker"
import SqliteBrowseWorker from "@/features/preview/workers/sqliteBrowse.worker.ts?worker"
import type { SqliteBrowseWorkerApi, SqliteOpenResult } from "@/features/preview/workers/sqliteBrowse.worker"
import { openOriginSyncSource } from "@/features/preview/lib/origin/syncSource"
import { openOriginRangeSource } from "@/features/preview/lib/origin/rangeSource"
import type { SqliteCheck, SqliteCount, SqliteLabels, SqliteOpenError, SqliteSchema } from "@/features/preview/lib/sqliteBrowser"
import type { SqliteTableReads } from "@/features/preview/lib/sqliteSource"
import { SQLITE_AUTO_CHECK_MAX_BYTES } from "@/features/preview/lib/sqliteBrowse.logic"

// The page's side of an open database: its owned worker, how its bytes reach it (the sync range bridge for a drive or
// link file, a whole read streamed into sqlite's memory otherwise), its reads, and the integrity check.

export type SqliteWorker = OwnedWorker<SqliteBrowseWorkerApi>

// A check walks the file once: a small ring is enough.
const CHECK_SLOTS = 8
// Row counting waits this long after the grid's last read, so tiles go first.
export const SQLITE_COUNT_IDLE_MS = 500

export function createSqliteWorker(): Worker {
	return new SqliteBrowseWorker()
}

export interface SqliteDatabase {
	readonly schema: SqliteSchema
	readonly size: number
	// Read through the range VFS (a drive or link file); else held whole in sqlite's memory.
	readonly ranged: boolean
	// The integrity check runs by itself (SQLITE_AUTO_CHECK_MAX_BYTES).
	readonly autoCheck: boolean
	// When the grid last read: counting waits for it to be idle.
	lastRead(): number
	reads(table: number): SqliteTableReads
	count(table: number): Promise<SqliteCount>
	// Ends the bridge (the worker is its owner's to end).
	close(): void
}

export type SqliteOpenOutcome =
	{ readonly ok: true; readonly database: SqliteDatabase } | { readonly ok: false; readonly reason: SqliteOpenError["reason"] }

export interface SqliteOpenOptions {
	readonly access: OriginAccess
	readonly token: string
	readonly labels: SqliteLabels
	// Shared with the worker: holding a request's id there interrupts it.
	readonly interrupt: Int32Array
}

// Opens `origin` in `owned`. Rejects when the bytes could not be reached at all (no session, a closed archive reader).
export async function openSqliteDatabase(owned: SqliteWorker, origin: ByteOrigin, options: SqliteOpenOptions): Promise<SqliteOpenOutcome> {
	const { access, token, labels, interrupt } = options
	const size = originSize(origin)
	const ranged = originRanged(origin)
	let close = (): void => undefined
	let result: SqliteOpenResult

	if (ranged) {
		const bridge = await openOriginSyncSource(origin, token, { access })

		close = () => {
			bridge.close()
		}
		result = await owned
			.run(remote =>
				remote.open(Comlink.transfer({ kind: "ranged", channel: bridge.channel }, [bridge.channel.port]), labels, interrupt)
			)
			.catch((error: unknown) => {
				bridge.close()

				throw error
			})
	} else {
		const source = await openOriginRangeSource(origin, token, { access })

		try {
			const port = await source.port()

			result = await owned.run(remote =>
				remote.open(Comlink.transfer({ kind: "whole", port, size: source.size }, [port]), labels, interrupt)
			)
		} finally {
			// Copied into sqlite's memory: the source is done with.
			source.close()
		}
	}

	const { schema, failure } = result

	if (schema === null) {
		close()

		return { ok: false, reason: failure?.reason ?? "damaged" }
	}

	let ids = 0
	let lastRead = 0
	const nextId = (): number => ++ids
	const database: SqliteDatabase = {
		schema,
		size,
		ranged,
		autoCheck: size <= SQLITE_AUTO_CHECK_MAX_BYTES,
		lastRead: () => lastRead,
		reads: table => ({
			tiles: (base, coordinates, id) => {
				lastRead = performance.now()

				return owned.run(remote => remote.tiles(table, base, coordinates, id))
			},
			cell: (base, row, col, id) => {
				lastRead = performance.now()

				return owned.run(remote => remote.cell(table, base, row, col, id))
			},
			nextId
		}),
		count: table => owned.run(remote => remote.count(table, nextId())),
		close
	}

	return { ok: true, database }
}

export interface SqliteCheckRun {
	readonly result: Promise<SqliteCheck>
	readonly cancel: () => void
}

// The integrity check (PRAGMA quick_check), reporting the bytes read so far. A database held whole is checked in its
// own worker; a ranged one in a second worker of its own reading through its own small bridge, so the grid keeps
// reading meanwhile; cancelling ends that worker at once.
export function runSqliteCheck(
	owned: SqliteWorker,
	database: SqliteDatabase,
	origin: ByteOrigin,
	options: SqliteOpenOptions,
	onProgress: (bytesRead: number) => void
): SqliteCheckRun {
	if (!database.ranged) {
		const id = 0x7fffffff

		Atomics.store(options.interrupt, 0, 0)

		return {
			result: owned.run(remote => remote.check(id, Comlink.proxy(onProgress))),
			cancel: () => {
				Atomics.store(options.interrupt, 0, id)
			}
		}
	}

	const checker = createOwnedWorker<SqliteBrowseWorkerApi>(createSqliteWorker, "sqlite-check")
	const token = crypto.randomUUID()
	const interrupt = new Int32Array(new SharedArrayBuffer(4))
	const run = { cancelled: false }
	// Read through a call: the flag changes while the check awaits.
	const cancelled = (): boolean => run.cancelled
	let end = (): void => {
		checker.terminate()
	}
	const result = (async (): Promise<SqliteCheck> => {
		const bridge = await openOriginSyncSource(origin, token, { access: options.access, slots: CHECK_SLOTS })

		end = () => {
			checker.terminate()
			bridge.close()
			void sdkApi.cancelPreviewDownload(token)
		}

		if (cancelled()) {
			end()

			return "cancelled"
		}

		try {
			const opened = await checker.run(remote =>
				remote.open(Comlink.transfer({ kind: "ranged", channel: bridge.channel }, [bridge.channel.port]), options.labels, interrupt)
			)

			if (opened.schema === null) {
				if (opened.failure?.reason === "unreadable") throw new Error(opened.failure.message)

				return "damaged"
			}

			return await checker.run(remote => remote.check(1, Comlink.proxy(onProgress)))
		} catch (error) {
			if (cancelled()) return "cancelled"

			throw error
		} finally {
			end()
		}
	})()

	return {
		result,
		cancel: () => {
			run.cancelled = true
			end()
		}
	}
}
