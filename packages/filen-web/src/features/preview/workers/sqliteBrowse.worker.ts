/// <reference lib="webworker" />
import * as Comlink from "comlink"
import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import { BLOCK_BYTES } from "@filen/shared/videos"
import { SyncRangeReader, type PdfByteChannel } from "@filen/office/dom/pdfedit"
import type { SheetTile } from "@filen/office/core/sheet"
import { RANGE_READ_TIMEOUT_MS, rangePortReader } from "@/lib/media/rangePort"
import {
	SqliteBrowser,
	SqliteOpenError,
	sqliteApiConfig,
	type SqliteCellValue,
	type SqliteCheck,
	type SqliteCount,
	type SqliteLabels,
	type SqliteSchema
} from "@/features/preview/lib/sqliteBrowser"

// One SQLite database, browsed read-only (lib/sqliteBrowser.ts): owned by its viewer, terminated with it. A drive or
// link file is read through the sync range bridge (only the pages sqlite asks for); an archive entry or held bytes
// stream whole into sqlite's memory, block by block, with no second copy anywhere.

export type SqliteOpenSource =
	| { readonly kind: "ranged"; readonly channel: PdfByteChannel }
	| { readonly kind: "whole"; readonly port: MessagePort; readonly size: number }

// One shape for both outcomes (a union does not survive Comlink's typing): the schema, or why the file did not open.
export interface SqliteOpenResult {
	readonly schema: SqliteSchema | null
	readonly failure: { readonly reason: SqliteOpenError["reason"]; readonly message: string } | null
}

let engine: Promise<Sqlite3Static> | null = null
let browser: SqliteBrowser | null = null

function sqlite(): Promise<Sqlite3Static> {
	if (engine === null) {
		Object.assign(globalThis, { sqlite3ApiConfig: sqliteApiConfig() })
		engine = sqlite3InitModule()
	}

	return engine
}

function opened(): SqliteBrowser {
	if (browser === null) throw new Error("sqliteBrowse.worker: open() first")

	return browser
}

// Streams the port's bytes into sqlite's heap at `pointer`, one block at a time; the heap view is taken again per
// block, since wasm memory may grow in between.
function wholeFill(port: MessagePort, size: number): (heap: () => Uint8Array, pointer: number) => Promise<void> {
	return async (heap, pointer) => {
		const reader = rangePortReader(port)
		const signal = new AbortController().signal

		try {
			for (let at = 0; at < size; at += BLOCK_BYTES) {
				const block = await reader.readRange(at, Math.min(size, at + BLOCK_BYTES), signal)

				heap().set(block, pointer + at)
			}
		} finally {
			reader.close()
		}
	}
}

const api = {
	open: async (source: SqliteOpenSource, labels: SqliteLabels, interrupt: Int32Array): Promise<SqliteOpenResult> => {
		const sqlite3 = await sqlite()

		try {
			browser = await SqliteBrowser.open(
				sqlite3,
				source.kind === "ranged"
					? {
							kind: "ranged",
							reader: new SyncRangeReader(source.channel.buffer, source.channel.port, source.channel.length, {
								deadlineMs: RANGE_READ_TIMEOUT_MS,
								now: () => performance.now()
							})
						}
					: { kind: "whole", size: source.size, fill: wholeFill(source.port, source.size) },
				labels,
				interrupt
			)

			return { schema: browser.schema, failure: null }
		} catch (error) {
			if (error instanceof SqliteOpenError) return { schema: null, failure: { reason: error.reason, message: error.message } }

			throw error
		}
	},
	count: async (table: number, id: number): Promise<SqliteCount> => {
		// A task boundary first, so tile requests posted meanwhile run before this chunk.
		await new Promise(resolve => setTimeout(resolve, 0))

		return opened().countStep(table, id)
	},
	tiles: (table: number, base: number, coordinates: Uint32Array, id: number): SheetTile[] => {
		const tiles = opened().tiles(table, base, coordinates, id)

		return Comlink.transfer(
			tiles,
			tiles.flatMap(tile => [tile.positions.buffer, tile.texts.buffer, tile.inputs.buffer, tile.styles.buffer, tile.flags.buffer])
		)
	},
	cell: (table: number, base: number, row: number, col: number, id: number): SqliteCellValue => opened().cell(table, base, row, col, id),
	check: (id: number, onProgress: (bytesRead: number) => void): SqliteCheck => opened().check(id, onProgress)
}

export type SqliteBrowseWorkerApi = typeof api

Comlink.expose(api)
