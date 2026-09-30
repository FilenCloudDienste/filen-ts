import * as Comlink from "comlink"
import SpreadsheetWorker from "@/features/spreadsheet/workers/spreadsheet.worker.ts?worker"
import type { SpreadsheetDoc, SpreadsheetKind } from "@/features/spreadsheet/lib/model"
import type { SpreadsheetFileKind, SpreadsheetWorkerApi } from "@/features/spreadsheet/workers/spreadsheet.worker"
import { idleResource } from "@/lib/idleResource"

type SpreadsheetRemote = Comlink.Remote<SpreadsheetWorkerApi>

// The worker keeps the hucre and HyperFormula code and whatever heap the largest workbook grew, so it is
// torn down once no document is open and no call is in flight; the next spreadsheet spins up a fresh one.
const SPREADSHEET_WORKER_IDLE_MS = 30_000

// One worker for every open spreadsheet, created the first time one opens.
const spreadsheetWorker = idleResource(
	() => {
		const worker = new SpreadsheetWorker()

		return { worker, remote: Comlink.wrap<SpreadsheetWorkerApi>(worker) }
	},
	({ worker, remote }) => {
		remote[Comlink.releaseProxy]()
		worker.terminate()
	},
	SPREADSHEET_WORKER_IDLE_MS
)

// The open documents, under ids never reused in this tab: a fresh worker numbers its own from 1 again, and
// a late call from a closed viewer must not reach a newer document. `release` ends the hold that keeps the
// worker while the document is open.
const documents = new Map<number, { workerId: number; release: () => void }>()
let nextId = 1

// Opens a document and keeps the worker until closeSpreadsheet: the hold starts before the bytes are sent,
// so a long parse is never torn down under.
export function openSpreadsheet(bytes: Uint8Array, kind: SpreadsheetFileKind): Promise<{ id: number; doc: SpreadsheetDoc }> {
	const opened = Promise.withResolvers<{ id: number; doc: SpreadsheetDoc }>()

	spreadsheetWorker
		.use(async ({ remote }) => {
			const result = await remote.open(bytes, kind)
			const closed = Promise.withResolvers<undefined>()
			const id = nextId++

			documents.set(id, {
				workerId: result.id,
				release: () => {
					closed.resolve(undefined)
				}
			})
			opened.resolve({ id, doc: result.doc })
			await closed.promise
		})
		.catch(opened.reject)

	return opened.promise
}

export function closeSpreadsheet(id: number): void {
	const document = documents.get(id)

	if (document === undefined) {
		return
	}

	documents.delete(id)
	// Sent before the hold ends, so the worker outlives it.
	void spreadsheetWorker.use(({ remote }) => remote.close(document.workerId))
	document.release()
}

// A call on an open document. Once the document is closed it rejects at once, as the worker itself would,
// without spinning a worker up.
export function withOpenSpreadsheet<R>(id: number, run: (remote: SpreadsheetRemote, workerId: number) => Promise<R>): Promise<R> {
	const document = documents.get(id)

	if (document === undefined) {
		return Promise.reject(new Error(`spreadsheet: no open document ${String(id)}`))
	}

	return spreadsheetWorker.use(({ remote }) => run(remote, document.workerId))
}

// A call that needs no open document.
export function withSpreadsheetWorker<R>(run: (remote: SpreadsheetRemote) => Promise<R>): Promise<R> {
	return spreadsheetWorker.use(({ remote }) => run(remote))
}

const ZIP = [0x50, 0x4b, 0x03, 0x04]
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
	return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte)
}

// A file whose name does not say what it is, read from its first bytes: a zip is taken for an .xlsx, an
// OLE2 compound file for an .xls, anything else for text.
export function sniffSpreadsheetKind(bytes: Uint8Array): SpreadsheetKind {
	if (startsWith(bytes, ZIP)) return "xlsx"
	if (startsWith(bytes, OLE2)) return "xls"

	return "csv"
}
