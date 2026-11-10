import { sheetWorkerHost, type SheetWorkerLike } from "@filen/office/dom/sheet"
import type {
	SheetEvent,
	SheetFileKind,
	SheetHost,
	SheetLockedFile,
	SheetOpenOptions,
	SheetOpenResult,
	SheetQueryResult,
	SheetSessionApi
} from "@filen/office/core/sheet"
import WorkbookWorker from "@/features/spreadsheet/workers/sheetWorkbook.worker.ts?worker"
import TextWorker from "@/features/spreadsheet/workers/sheetText.worker.ts?worker"
import { sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { loadedRegionalLanguage } from "@/features/office/lib/regionalFormat"
import { recoverIfNewerBuild } from "@/lib/appUpdate"

// A worker keeps its code and the heap its largest file grew, so it is terminated once nothing is open in it for
// this long; the next file starts a fresh one.
const SHEET_WORKER_IDLE_MS = 30_000

interface Held {
	readonly host: SheetHost
	users: number
	broken: boolean
}

function workerLike(worker: Worker): SheetWorkerLike {
	return {
		postMessage: (message, transfer = []) => {
			worker.postMessage(message, transfer)
		},
		addEventListener: (type, listener) => {
			if (type === "message") {
				worker.addEventListener("message", listener)
			} else {
				worker.addEventListener("error", listener)
			}
		},
		terminate: () => {
			worker.terminate()
		}
	}
}

// One worker host, created on first use and held while any open, locked file or session lives in it. A worker that
// died is replaced at the next open (its sessions already heard "failed").
function hostPool(create: () => Worker) {
	let held: Held | null = null
	let timer: ReturnType<typeof setTimeout> | undefined

	function acquire(): { readonly host: SheetHost; readonly release: () => void } {
		clearTimeout(timer)
		timer = undefined

		if (held === null || held.broken) {
			// A broken worker nothing uses any more goes now; one still in use goes with its last user.
			if (held !== null && held.users === 0) {
				held.host.dispose()
			}

			const worker = create()
			const entry: Held = { host: sheetWorkerHost(workerLike(worker)), users: 0, broken: false }

			worker.addEventListener("error", () => {
				entry.broken = true
				// A deploy that changed this worker removes its old file (appUpdate.ts).
				recoverIfNewerBuild()
			})
			held = entry
		}

		const entry = held
		let released = false

		entry.users++

		return {
			host: entry.host,
			release: () => {
				if (released) {
					return
				}

				released = true
				entry.users--

				if (entry.users > 0) {
					return
				}

				if (entry.broken || held !== entry) {
					if (held === entry) {
						held = null
					}

					entry.host.dispose()

					return
				}

				timer = setTimeout(() => {
					if (held === entry && entry.users === 0) {
						held = null
						entry.host.dispose()
					}
				}, SHEET_WORKER_IDLE_MS)
			}
		}
	}

	// The session holds the worker until it closes.
	function leased(session: SheetSessionApi, release: () => void): SheetSessionApi {
		return {
			...session,
			close: () => {
				session.close()
				release()
			}
		}
	}

	function lockedLease(locked: SheetLockedFile, release: () => void): SheetLockedFile {
		let opened = false

		return {
			scheme: locked.scheme,
			spinCount: locked.spinCount,
			unlock: async (password, options) => {
				const result = await locked.unlock(password, options)

				if (!result.ok) {
					return result
				}

				opened = true

				return { ...result, session: leased(result.session, release) }
			},
			dispose: () => {
				locked.dispose()

				if (!opened) {
					release()
				}
			}
		}
	}

	return async (bytes: Uint8Array, options: SheetOpenOptions, onEvent: (event: SheetEvent) => void): Promise<SheetOpenResult> => {
		const lease = acquire()
		let result: SheetOpenResult

		try {
			result = await lease.host.open(bytes, options, onEvent)
		} catch (error) {
			lease.release()

			return { kind: "failed", reason: "failed", message: error instanceof Error ? error.message : String(error) }
		}

		switch (result.kind) {
			case "opened":
				return { ...result, session: leased(result.session, lease.release) }
			case "needsPassword":
				return { kind: "needsPassword", locked: lockedLease(result.locked, lease.release) }
			default:
				lease.release()

				return result
		}
	}
}

const openWorkbook = hostPool(() => new WorkbookWorker())
const openText = hostPool(() => new TextWorker())

export function isTextSheetKind(kind: SheetFileKind): boolean {
	return kind === "csv" || kind === "tsv" || kind === "tab"
}

// Opens a file in the worker for its kind: a text file never loads the workbook worker's code. The bytes are
// transferred: pass a copy of anything still held elsewhere. A text file opens in the regional format (Settings,
// Office; the browser's by default), whose list separator settles a CSV's separator where the file leaves it open, as
// the grid then shows it.
export async function openSheet(
	bytes: Uint8Array,
	options: SheetOpenOptions,
	onEvent: (event: SheetEvent) => void
): Promise<SheetOpenResult> {
	if (!isTextSheetKind(options.kind)) {
		return openWorkbook(bytes, options, onEvent)
	}

	return openText(
		bytes,
		options.settings?.locale === undefined
			? { ...options, settings: { ...options.settings, locale: sheetLocaleOf(await loadedRegionalLanguage()) } }
			: options,
		onEvent
	)
}

// Save as .xlsx of a text file: its cells as the text session handed them out (the saveAs.cells query, a UTF-8
// TSV), made a workbook in the workbook worker, which holds the writer (the text worker never loads it). The
// session opened there for it closes once done. Transferred: pass bytes nothing else holds.
export async function textToXlsx(cells: Uint8Array, name: string): Promise<SheetQueryResult<"saveAs.xlsx">> {
	const opened = await openWorkbook(cells, { kind: "tsv" }, () => undefined)

	if (opened.kind !== "opened") {
		// A text file asks no password; what holds the worker goes all the same.
		if (opened.kind === "needsPassword") {
			opened.locked.dispose()
		}

		return { ok: false, refusal: { reason: "unsupported", detail: opened.kind } }
	}

	try {
		return await opened.session.query("saveAs.xlsx", { name })
	} finally {
		opened.session.close()
	}
}
