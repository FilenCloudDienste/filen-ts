import * as Comlink from "comlink"
import { originRanged, originSize, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import { sdkApi } from "@/lib/sdk/client"
import { createOwnedWorker, type OwnedWorker } from "@/lib/workers/ownedWorker"
import SqliteBrowseWorker from "@/features/preview/workers/sqliteBrowse.worker.ts?worker"
import type { SqliteBrowseWorkerApi, SqliteOpenResult } from "@/features/preview/workers/sqliteBrowse.worker"
import { openOriginSyncSource } from "@/features/preview/lib/origin/syncSource"
import { openOriginRangeSource } from "@/features/preview/lib/origin/rangeSource"
import {
	isSqliteUnreadable,
	type SqliteCellValue,
	type SqliteCheck,
	type SqliteCount,
	type SqliteLabels,
	type SqliteOpenError,
	type SqliteSchema
} from "@/features/preview/lib/sqliteBrowser"
import type { SqliteTableReads } from "@/features/preview/lib/sqliteSource"
import {
	INTERRUPT_CHECK,
	INTERRUPT_COUNT,
	INTERRUPT_TILES,
	SQLITE_AUTO_CHECK_MAX_BYTES,
	SQLITE_INTERRUPT_SLOTS
} from "@/features/preview/lib/sqliteBrowse.logic"

// The page's side of an open database: its owned worker, how its bytes reach it (readsInRanges: the sync range bridge
// for a large drive or link file, a whole read streamed into sqlite's memory otherwise), its reads, and the integrity
// check.

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
	// Read through the range VFS (a drive or link file past the check's size); else held whole in sqlite's memory.
	readonly ranged: boolean
	// The integrity check runs by itself (SQLITE_AUTO_CHECK_MAX_BYTES).
	readonly autoCheck: boolean
	// When the grid last read: counting waits for it to be idle.
	lastRead(): number
	// One per table, the same object each time.
	reads(table: number): SqliteTableReads
	// Null when a grid read went ahead of the step: count on later.
	count(table: number): Promise<SqliteCount | null>
	// Called when a read fails after the database opened (the bridge's read aborted or timed out); returns the
	// unsubscribe.
	onUnreadable(listener: () => void): () => void
	// Ends the bridge (the worker is its owner's to end).
	close(): void
}

// A database the check reads whole anyway (SQLITE_AUTO_CHECK_MAX_BYTES or less) is read whole into sqlite's memory
// once, so the check, the counting and the tiles never download a byte twice; a larger one in ranges. An origin read
// whole only (an archive entry, held bytes) is always read whole.
export function readsInRanges(origin: ByteOrigin): boolean {
	return originRanged(origin) && originSize(origin) > SQLITE_AUTO_CHECK_MAX_BYTES
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
	const ranged = readsInRanges(origin)
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

		// The whole path's peak is the database twice for an archive entry until the SDK reads entries in ranges: the
		// SDK worker holds the decoded entry while it is copied into sqlite's memory.
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

	const database: SqliteDatabase = {
		schema,
		size,
		ranged,
		autoCheck: size <= SQLITE_AUTO_CHECK_MAX_BYTES,
		...sqliteReads(owned, interrupt),
		close
	}

	return { ok: true, database }
}

export type SqliteReads = Pick<SqliteDatabase, "lastRead" | "reads" | "count" | "onUnreadable">

// The grid's reads of an open database, each named for the interrupt flag: a tile request makes every earlier one
// stale (the grid asks again for what it still shows once the newer lands), and any grid read stops the count step in
// flight, so tiles never wait on a chunk. A cell is read once for both of its readers (the grid's own query for a
// clipped value, the selection bar). A read that failed reaches every onUnreadable listener.
export function sqliteReads(owned: Pick<SqliteWorker, "run">, interrupt: Int32Array): SqliteReads {
	let ids = 0
	let lastRead = 0
	// The count step in flight: a grid read that arrives meanwhile stops it, so tiles never wait on a chunk.
	let counting = 0
	const nextId = (): number => ++ids
	const unreadable = new Set<() => void>()
	const tables = new Map<number, SqliteTableReads>()
	const watch = <T>(read: Promise<T>): Promise<T> =>
		read.catch((error: unknown) => {
			if (isSqliteUnreadable(error)) {
				for (const listener of unreadable) listener()
			}

			throw error
		})
	const gridRead = (): number => {
		lastRead = performance.now()

		if (counting !== 0) Atomics.store(interrupt, INTERRUPT_COUNT, counting)

		return nextId()
	}
	const tableReads = (table: number): SqliteTableReads => {
		// The last cell read, shared by the grid's own query and the selection bar's.
		let lastCell: { key: string; value: Promise<SqliteCellValue> } | null = null

		return {
			tiles: (base, coordinates) => {
				const id = gridRead()

				// Every earlier tile request is stale: the grid asks again for what it still shows once this one lands.
				Atomics.store(interrupt, INTERRUPT_TILES, id - 1)

				return watch(owned.run(remote => remote.tiles(table, base, coordinates, id)))
			},
			cell: (base, row, col) => {
				const key = `${String(base)}:${String(row)}:${String(col)}`

				if (lastCell?.key !== key) {
					const id = gridRead()

					const entry = { key, value: watch(owned.run(remote => remote.cell(table, base, row, col, id))) }

					lastCell = entry
					// A failed read is not kept: the next one asks again.
					entry.value.catch(() => {
						if (lastCell === entry) lastCell = null
					})

					return entry.value
				}

				return lastCell.value
			}
		}
	}

	return {
		lastRead: () => lastRead,
		reads: table => {
			let reads = tables.get(table)

			if (reads === undefined) {
				reads = tableReads(table)
				tables.set(table, reads)
			}

			return reads
		},
		count: table => {
			const id = nextId()

			counting = id

			return watch(owned.run(remote => remote.count(table, id))).finally(() => {
				if (counting === id) counting = 0
			})
		},
		onUnreadable: listener => {
			unreadable.add(listener)

			return () => {
				unreadable.delete(listener)
			}
		}
	}
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
		const id = Atomics.add(options.interrupt, INTERRUPT_CHECK, 0) + 1

		return {
			result: owned.run(remote => remote.check(id, Comlink.proxy(onProgress))),
			cancel: () => {
				Atomics.store(options.interrupt, INTERRUPT_CHECK, id)
			}
		}
	}

	const checker = createOwnedWorker<SqliteBrowseWorkerApi>(createSqliteWorker, "sqlite-check")
	const token = crypto.randomUUID()
	const interrupt = new Int32Array(new SharedArrayBuffer(4 * SQLITE_INTERRUPT_SLOTS))
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
