import { describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import { PDF_DESKTOP_MEMORY, type PdfEditState } from "@filen/office/core/pdfedit"
import { PdfEngineError, type PdfOpenResult, type PdfSaveBegun } from "@filen/office/dom/pdfedit"
import { engineDocumentPermissions, type PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { DriveItem } from "@/features/drive/lib/item"
import type { ErrorDTO } from "@/lib/sdk/errors"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"
import type { PdfToolContext } from "@/features/pdf/tools/registry"

// Every save ends, whatever fails on its way, and holds the editor's changes until it did; an account whose versioning
// is not known is taken as keeping none; a fresh engine that does not open after a save is told apart from a lost session; drafts typed into
// fields are saved; the engine's own reading of the document's restrictions decides printing; a redaction saved as a
// copy is taken back out of the document.

vi.mock("@/features/pdf/session/engineModule", () => ({ prefetchPdfEngine: () => undefined }))
vi.mock("@/features/preview/lib/editedCopy", () => ({ writeEditedCopy: vi.fn() }))
vi.mock("@/features/preview/lib/ownSaves", () => ({ recordOwnSave: () => undefined }))

const account: { current: { readonly versioningEnabled: boolean } | undefined } = { current: undefined }

vi.mock("@/queries/account", async importOriginal => ({
	...(await importOriginal<typeof import("@/queries/account")>()),
	accountQueryGet: () => account.current
}))

const { savePdfCopy, savePdfVersion } = await import("@/features/pdf/save/pdfSave")
const { PdfEditSwap } = await import("@/features/pdf/session/swap")
const { FormOverlaySession } = await import("@/features/pdf/session/fieldOverlay.logic")
const { pdfEditActions } = await import("@/features/pdf/session/pdfEditActions")
const { applyRedactions } = await import("@/features/pdf/redact/redactFlow")
const { writeEditedCopy } = await import("@/features/preview/lib/editedCopy")
const { accountKeepsVersions } = await import("@/features/pdf/save/accountVersions")

const STATE = {
	revision: 1,
	pageCount: 1,
	dirty: true,
	encryption: { method: "None", access: "none" },
	restrictions: { owner: true }
} as unknown as PdfEditState

const ITEM = { type: "file", data: { uuid: "u", size: 1000n, timestamp: 0n, decryptedMeta: { created: 0n } } } as unknown as DriveItem

const WRITTEN: PdfSaveBegun = {
	status: "written",
	plan: { mode: "full", encryption: "keep", invalidates: [], peakBytes: 1, options: "", refuse: null },
	size: 10,
	versions: 1,
	encryption: "None",
	redaction: null,
	removesContent: false,
	protection: { kind: "keep" }
}

interface Calls {
	readonly ops: { readonly op: string; readonly args: unknown }[]
	held: number
}

// A save's deps over a fake engine that runs one request at a time, as the engine does: writeOutput holds the requests
// after it until `upload` answers it, or the page aborts its end of the port (never, when neither comes).
function saveDeps(calls: Calls, options: { upload?: Promise<{ uploaded: boolean }>; versioning?: () => boolean } = {}) {
	let writing: Promise<unknown> = Promise.resolve()
	const call = (op: string, args: unknown): Promise<unknown> => {
		calls.ops.push({ op, args })

		switch (op) {
			case "saveBegin":
				return Promise.resolve(WRITTEN)
			case "saveEnd":
				return writing.then(() => ({ state: STATE, heapBytes: 0, history: "kept" }))
			case "writeOutput": {
				const { port } = args as { readonly port: MessagePort }
				const aborted = new Promise(resolve => {
					port.addEventListener("message", (event: MessageEvent<Record<string, unknown>>) => {
						if (event.data["filen.savePort"] === "abort") resolve({ uploaded: false })
					})
					port.start()
				})

				// The engine's writer says it is going to write (savePort "alive").
				port.postMessage({ "filen.savePort": "alive" })
				writing = Promise.race([options.upload ?? new Promise(() => undefined), aborted])

				return writing
			}
			case "checkSaved":
				return Promise.resolve({ ok: true })
			default:
				return Promise.resolve(null)
		}
	}
	const engine = { client: { call }, opened: { status: "open" }, close: () => Promise.resolve({ heapBytes: 0 }) } as unknown as PdfEngine

	return {
		engine,
		session: { getSnapshot: () => ({ state: STATE }), saved: vi.fn() } as unknown as PdfEditSessionModel,
		memory: PDF_DESKTOP_MEMORY,
		fileBytes: 1000,
		password: undefined,
		openVerifier: () => Promise.resolve(engine),
		versioning: options.versioning ?? (() => true),
		needsRespawn: () => false,
		respawn: vi.fn(() => Promise.resolve(true)),
		onHistoryReset: vi.fn(),
		hold: () => {
			calls.held++

			let released = false

			return () => {
				if (!released) calls.held--

				released = true
			}
		}
	}
}

function ends(calls: Calls): unknown[] {
	return calls.ops.filter(entry => entry.op === "saveEnd").map(entry => entry.args)
}

describe("every PDF save ends", () => {
	it("ends a copy whose upload failed, even with the engine's write still waiting, and lets changes run again", async () => {
		const calls: Calls = { ops: [], held: 0 }
		const deps = saveDeps(calls)

		await expect(savePdfCopy(deps, () => Promise.reject(new Error("upload")))).rejects.toThrow("upload")
		expect(ends(calls)).toEqual([{ outcome: "failed", next: "continue" }])
		expect(calls.held).toBe(0)
	})

	it("ends a copy the drive refused as failed, and a copy made as copied", async () => {
		const failed: Calls = { ops: [], held: 0 }
		const refused = { outcome: { status: "error" as const, dto: {} as ErrorDTO }, name: "a (edited).pdf" }

		expect(await savePdfCopy(saveDeps(failed), () => Promise.resolve(refused))).toBe(refused)
		expect(ends(failed)).toEqual([{ outcome: "failed", next: "continue" }])

		const made: Calls = { ops: [], held: 0 }
		const copy = { outcome: { status: "success" as const, item: ITEM }, name: "a (edited).pdf" }

		expect(await savePdfCopy(saveDeps(made, { upload: Promise.resolve({ uploaded: true }) }), () => Promise.resolve(copy))).toBe(copy)
		expect(ends(made)).toEqual([{ outcome: "copied", next: "continue" }])
		expect(made.held).toBe(0)
	})

	it("plans the save of a draft of extracted pages from the draft's own size, not the PDF it came from", async () => {
		const calls: Calls = { ops: [], held: 0 }
		const copy = { outcome: { status: "success" as const, item: ITEM }, name: "a (extracted).pdf" }
		const deps = { ...saveDeps(calls, { upload: Promise.resolve({ uploaded: true }) }), fileBytes: 40 }

		await savePdfCopy(deps, () => Promise.resolve(copy))
		expect(calls.ops.find(entry => entry.op === "saveBegin")?.args).toMatchObject({ inputBytes: 40 })
	})

	it("holds changes from the start of a version save until its upload failed, or it was committed or abandoned", async () => {
		const failed: Calls = { ops: [], held: 0 }
		const edits = await savePdfVersion(saveDeps(failed, { upload: Promise.resolve({ uploaded: false }) }), ITEM)

		expect(await edits.result).toEqual({ kind: "refused", reason: "failed" })
		expect(ends(failed)).toEqual([{ outcome: "failed", next: "continue" }])
		expect(failed.held).toBe(0)

		const committed: Calls = { ops: [], held: 0 }
		const kept = await savePdfVersion(saveDeps(committed, { upload: Promise.resolve({ uploaded: true }) }), ITEM)

		expect(committed.held).toBe(1)
		await kept.commit(ITEM)
		expect(committed.held).toBe(0)

		// A copy made of it instead (the overlay's "save mine as a new file").
		const abandoned: Calls = { ops: [], held: 0 }
		const copied = await savePdfVersion(saveDeps(abandoned, { upload: Promise.resolve({ uploaded: true }) }), ITEM)

		await copied.abandon?.()
		expect(ends(abandoned)).toEqual([{ outcome: "failed", next: "continue" }])
		expect(abandoned.held).toBe(0)
	})

	it("takes an account whose versioning is not known as keeping no earlier versions", async () => {
		account.current = undefined
		expect(accountKeepsVersions()).toBe(false)
		account.current = { versioningEnabled: true }
		expect(accountKeepsVersions()).toBe(true)

		account.current = undefined

		const calls: Calls = { ops: [], held: 0 }

		await (
			await savePdfVersion(saveDeps(calls, { upload: Promise.resolve({ uploaded: true }), versioning: accountKeepsVersions }), ITEM)
		).commit(ITEM)
		// Without earlier versions, the session moves onto the written file.
		expect(ends(calls)).toEqual([{ outcome: "saved", next: "adopt" }])
	})

	it("does not say the history started again when the fresh engine did not open", async () => {
		const calls: Calls = { ops: [], held: 0 }
		const deps = { ...saveDeps(calls, { upload: Promise.resolve({ uploaded: true }) }), needsRespawn: () => true }

		deps.respawn.mockResolvedValueOnce(false)
		await (await savePdfVersion(deps, ITEM)).commit(ITEM)
		expect(deps.respawn).toHaveBeenCalledTimes(1)
		expect(deps.onHistoryReset).not.toHaveBeenCalled()
		expect(calls.held).toBe(0)
	})
})

const FILE = { uuid: "f" } as unknown as AnyFile

// An engine whose answers are canned; `unreadable`: its state cannot be read (it went).
function fakeEngine(
	log: string[],
	opened: PdfOpenResult = { status: "open", access: "none", document: { encryption: "None" } as never },
	unreadable = false
) {
	let closed = 0
	const call = (op: string): Promise<unknown> => {
		log.push(op)

		if (unreadable) return Promise.reject(new Error("closed"))

		return Promise.resolve(op === "state" ? STATE : { pages: [0], state: STATE, widgets: [] })
	}
	const engine = {
		client: { call, queued: (op: string) => ({ promise: call(op), cancel: () => undefined }) } as unknown as PdfEngine["client"],
		opened,
		close: () => {
			closed++

			return Promise.resolve({ heapBytes: 0 })
		}
	}

	return { engine: engine as PdfEngine, closed: () => closed }
}

async function editing(swap: InstanceType<typeof PdfEditSwap>): Promise<void> {
	swap.setFile(FILE)
	swap.warm()
	await vi.waitFor(() => {
		expect(swap.getSnapshot().kind).toBe("editing")
	})
}

describe("the editor around a save", () => {
	it("holds changes during a save and a respawn, then runs them on the fresh engine in order", async () => {
		const first: string[] = []
		const second: string[] = []
		const swap = new PdfEditSwap({
			open: () => Promise.resolve(fakeEngine(first).engine),
			mobile: false,
			onChangeFailed: () => undefined
		})

		await editing(swap)

		const release = swap.hold()

		expect(swap.getSnapshot()).toMatchObject({ kind: "editing", saving: true })
		swap.edit(session => session.dispatch("forms.reset", {}))
		swap.edit(session => session.undo())
		await new Promise(resolve => setTimeout(resolve, 10))
		expect(first).toEqual(["state"])

		expect(await swap.respawn(() => Promise.resolve(fakeEngine(second).engine))).toBe(true)
		expect(swap.getSnapshot()).toMatchObject({ kind: "editing", saving: true, respawned: true })
		release()
		await vi.waitFor(() => {
			expect(second).toEqual(["state", "dispatch", "undo"])
		})
		expect(swap.getSnapshot()).toMatchObject({ saving: false })
	})

	it("says a fresh engine did not open after a save, keeps the changes made meanwhile, and tries again", async () => {
		const later: string[] = []
		let reopen = false
		const swap = new PdfEditSwap({ open: () => Promise.resolve(fakeEngine([]).engine), mobile: false, onChangeFailed: () => undefined })

		await editing(swap)

		const release = swap.hold()

		swap.edit(session => session.dispatch("forms.reset", {}))
		expect(await swap.respawn(() => (reopen ? Promise.resolve(fakeEngine(later).engine) : Promise.reject(new Error("offline"))))).toBe(
			false
		)
		release()
		expect(swap.getSnapshot().kind).toBe("reopenFailed")

		reopen = true
		swap.retry()
		await vi.waitFor(() => {
			expect(swap.getSnapshot()).toMatchObject({ kind: "editing", respawned: true })
		})
		await vi.waitFor(() => {
			expect(later).toEqual(["state", "dispatch"])
		})
	})

	it("closes an engine that opened after the editor was closed, or whose document could not be read", async () => {
		const swap = new PdfEditSwap({ open: () => Promise.resolve(fakeEngine([]).engine), mobile: false, onChangeFailed: () => undefined })

		await editing(swap)

		const late = fakeEngine([])
		let opened: (engine: PdfEngine) => void = () => undefined
		const respawning = swap.respawn(
			() =>
				new Promise<PdfEngine>(resolve => {
					opened = resolve
				})
		)

		swap.close()
		opened(late.engine)
		expect(await respawning).toBe(false)
		expect(late.closed()).toBe(1)
		expect(swap.getSnapshot().kind).toBe("view")

		// Its state not read: closed, and the editor says the saved file did not open again.
		await editing(swap)

		const broken = fakeEngine([], undefined, true)

		expect(await swap.respawn(() => Promise.resolve(broken.engine))).toBe(false)
		expect(broken.closed()).toBe(1)
		expect(swap.getSnapshot().kind).toBe("reopenFailed")
	})

	it("reads the document's restrictions from the engine, as pdf.js reports them", async () => {
		const restricted: PdfOpenResult = {
			status: "open",
			access: "user",
			document: {
				pageCount: 1,
				versions: 1,
				repaired: false,
				format: "PDF 1.7",
				encryption: "AES 256-bit",
				permissions: {
					print: false,
					printHq: false,
					copy: true,
					edit: false,
					annotate: true,
					form: true,
					assemble: false,
					accessibility: true
				}
			}
		}
		const flags = engineDocumentPermissions(restricted)

		expect(flags?.has(0x04)).toBe(false)
		expect(flags?.has(0x20)).toBe(true)
		expect(engineDocumentPermissions({ ...restricted, access: "owner" })).toBeNull()

		// The editor's document answers with it, even with no viewer document to read it from.
		const swap = new PdfEditSwap({
			open: () => Promise.resolve(fakeEngine([], restricted).engine),
			mobile: false,
			onChangeFailed: () => undefined
		})

		await editing(swap)

		const phase = swap.getSnapshot()
		const permissions = phase.kind === "editing" ? await phase.session.getSnapshot().document.getPermissions() : null

		expect(permissions?.has(0x04)).toBe(false)
	})
})

describe("drafts typed into form fields", () => {
	it("are unsaved changes, committed as their field's value before a save, and kept when that fails", async () => {
		const form = new FormOverlaySession()
		const changes: string[] = []
		const listener = vi.fn()

		form.subscribe(listener)
		form.setDraft(7, { page: 1, text: "Ada" })
		expect(form.drafted()).toBe(true)
		expect(listener).toHaveBeenCalledTimes(1)

		const session = (fail: boolean) =>
			({
				dispatch: (command: string, args: unknown) => {
					changes.push(`${command} ${JSON.stringify(args)}`)

					return fail ? Promise.reject(new Error("refused")) : Promise.resolve(null)
				}
			}) as unknown as PdfEditSessionModel

		await form.commitDrafts(change => {
			void change(session(true)).catch(() => undefined)
		})
		expect(form.drafted()).toBe(true)

		await form.commitDrafts(change => {
			void change(session(false))
		})
		expect(form.drafted()).toBe(false)
		expect(changes.at(-1)).toBe('forms.setField {"page":1,"widget":7,"value":{"kind":"text","text":"Ada"}}')
	})

	it("are committed by Save as copy before the save begins", async () => {
		const calls: Calls = { ops: [], held: 0 }
		const order: string[] = []
		const deps = saveDeps(calls)
		const base = { ...deps, engine: deps.engine }
		const actions = pdfEditActions(
			() => ({
				...base,
				engine: {
					...deps.engine,
					client: {
						call: (op: string, args: unknown) => {
							order.push(op)

							return deps.engine.client.call(op as "state", args as never)
						}
					}
				} as unknown as PdfEngine,
				commitDrafts: () => {
					order.push("drafts")

					return Promise.resolve()
				},
				askRemote: () => Promise.resolve("cancel" as const),
				copySuffix: () => "edited",
				onCopied: () => undefined,
				onCopyFailed: () => undefined,
				takeRequest: () => null
			}),
			ITEM
		)

		vi.mocked(writeEditedCopy).mockResolvedValueOnce(null)
		await actions.saveCopy()
		expect(order.slice(0, 2)).toEqual(["drafts", "saveBegin"])
	})
})

describe("a redaction saved as a copy", () => {
	it("is undone in the document afterwards, all of its steps at once", async () => {
		const undone: (number | undefined)[] = []
		const session = {
			engine: {
				call: (op: string) => Promise.resolve(op === "redactMarks" ? [{ page: 0, id: 1, kind: "area", rect: [0, 0, 1, 1] }] : [])
			},
			dispatch: () => Promise.resolve(null),
			undo: (steps?: number) => {
				undone.push(steps)

				return Promise.resolve(null)
			},
			getSnapshot: () => ({ state: STATE })
		} as unknown as PdfEditSessionModel
		const context = {
			edit: (change: (session: PdfEditSessionModel) => Promise<unknown>) => {
				void change(session)
			},
			host: { save: () => Promise.resolve({ status: "saved", name: "a (redacted).pdf" }) }
		} as unknown as PdfToolContext

		const outcome = await applyRedactions(context, {
			sanitize: true,
			removeAnnotations: false,
			destination: { kind: "copy", name: "a (redacted).pdf" },
			copySuffix: () => "redacted"
		})

		expect(outcome).toEqual({ kind: "saved", copy: "a (redacted).pdf" })
		// The page's mark applied, then the sanitize.
		expect(undone).toEqual([2])
	})

	it("is refused by the engine past the size it edits, said as such", () => {
		expect(new PdfEngineError("overBudget", "").failure).toBe("overBudget")
	})
})
