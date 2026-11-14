import { describe, expect, it, vi } from "vitest"
import type { TFunction } from "i18next"
import { savePortReader, savePortWriter, type SavePortEnd } from "@filen/shared/savePort"
import { PDF_DESKTOP_MEMORY } from "@filen/office/core/pdfedit"
import type { PdfCommandResult, PdfEditState } from "@filen/office/core/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { DriveItem } from "@/features/drive/lib/item"
import { PdfPagesController, type PdfPagesHost } from "@/features/pdf/pages/pagesController"
import { bookmarkStarts, cropMargins, hasMargins, pageShown, unrotateMargins } from "@/features/pdf/pages/pagesSurface.logic"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"
import { previewPdfPages } from "@/locales/en/previewPdf/pages"

// The pages controller: page ids and the selection following each change, the live region's sentence, the last-page
// refusal, the rail's current page against the viewer's, a second PDF's password prompt, and new files made one at a
// time (written, checked, uploaded, ended); and the crop geometry helpers.

const t = ((key: string, params: Record<string, unknown> = {}) => {
	const catalog: Record<string, string> = previewPdfPages
	const count = params["count"]
	const plural = typeof count === "number" ? catalog[`${key}_${count === 1 ? "one" : "other"}`] : undefined
	const text = plural ?? catalog[key] ?? key

	return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name]))
}) as unknown as TFunction<"preview">

function state(pageCount: number, extra: Partial<PdfEditState> = {}): PdfEditState {
	return { pageCount, tagged: false, revision: 1, ...extra } as unknown as PdfEditState
}

interface FakeSession {
	readonly session: PdfEditSessionModel
	readonly dispatched: { command: string; args: unknown }[]
	readonly calls: { op: string; args: unknown }[]
	count: number
}

// A session whose commands answer with the pages `touched` gives back, its engine with `engine`.
function fakeSession(
	count: number,
	touched: (command: string, args: unknown) => { readonly pages: number[]; readonly count: number; readonly tagged?: boolean },
	engine: (op: string, args: unknown) => Promise<unknown> = () => Promise.resolve(null)
): FakeSession {
	const fake: FakeSession = {
		session: null as unknown as PdfEditSessionModel,
		dispatched: [],
		calls: [],
		count
	}
	const session = {
		getSnapshot: () => ({ state: state(fake.count) }),
		dispatch: (command: string, args: unknown): Promise<PdfCommandResult> => {
			fake.dispatched.push({ command, args })

			const result = touched(command, args)

			fake.count = result.count

			return Promise.resolve({ pages: result.pages, state: state(result.count, { tagged: result.tagged ?? false }), widgets: [] })
		},
		engine: {
			call: (op: string, args: unknown) => {
				fake.calls.push({ op, args })

				return engine(op, args)
			},
			queued: () => ({ promise: Promise.reject(new Error("no renders")), cancel: () => undefined })
		}
	}

	Object.assign(fake, { session })

	return fake
}

function host(fake: FakeSession, overrides: Partial<PdfPagesHost> = {}): PdfPagesHost & { failed: string[]; copied: string[][] } {
	const failed: string[] = []
	const copied: string[][] = []

	return {
		t,
		edit: change => {
			void change(fake.session)
		},
		access: "authed",
		password: () => undefined,
		memory: () => PDF_DESKTOP_MEMORY,
		openVerifier: () => Promise.reject(new Error("no verifier")),
		write: () => Promise.resolve(null),
		fileSize: 1000,
		onCopied: names => {
			copied.push([...names])
		},
		onFailed: key => {
			failed.push(key)
		},
		failed,
		copied,
		...overrides
	}
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

describe("page changes", () => {
	it("keeps a moved page's id, follows it with the current page and says where it went", async () => {
		const fake = fakeSession(4, () => ({ pages: [0, 1, 2], count: 4 }))
		const controller = new PdfPagesController()
		const navigate = vi.fn()

		controller.bind(host(fake))
		controller.setNavigator(navigate)
		controller.sync(4)

		const ids = controller.getSnapshot().ids

		controller.choose(2)
		controller.move([2, 0, 1, 3])
		await settle()

		const view = controller.getSnapshot()

		expect(fake.dispatched).toEqual([{ command: "pages.move", args: { order: [2, 0, 1, 3] } }])
		expect(view.ids).toEqual([ids[2], ids[0], ids[1], ids[3]])
		expect(view.current).toBe(0)
		expect(navigate).toHaveBeenLastCalledWith(0)
		expect(view.announcement).toBe("Page 3 moved to position 1")
		expect(view.changed).toEqual([ids[2], ids[0], ids[1]])
	})

	it("deletes, duplicates and inserts with new ids where pages are new, and the selection following", async () => {
		const fake = fakeSession(4, (command, args) => {
			if (command === "pages.delete") return { pages: [1, 2], count: 3 }
			if (command === "pages.duplicate") return { pages: [1, 2, 3], count: 4 }

			return { pages: [1], count: (fake.count += 0) + 1, tagged: (args as { at?: number }).at === 1 }
		})
		const controller = new PdfPagesController()

		controller.bind(host(fake))
		controller.sync(4)

		const ids = controller.getSnapshot().ids

		controller.select(new Set([1, 3]))
		controller.remove([1])
		await settle()
		expect(controller.getSnapshot().ids).toEqual([ids[0], ids[2], ids[3]])
		expect([...controller.getSnapshot().selected]).toEqual([2])
		expect(controller.getSnapshot().announcement).toBe("Page 2 deleted")

		controller.duplicate([0])
		await settle()

		const duplicated = controller.getSnapshot().ids

		expect(duplicated).toHaveLength(4)
		expect(duplicated[0]).toBe(ids[0])
		expect(ids).not.toContain(duplicated[1])
		expect(controller.getSnapshot().announcement).toBe("Page 1 duplicated")

		controller.choose(0)
		controller.insertBlank()
		await settle()
		expect(fake.dispatched.at(-1)).toEqual({ command: "pages.insertBlank", args: { at: 1, count: 1 } })
		expect(controller.getSnapshot().ids).toHaveLength(5)
		expect(controller.getSnapshot().announcement).toBe("Page inserted at position 2")
		// A tagged document's notice shows once.
		expect(controller.getSnapshot().taggedNotice).toBe(true)
		controller.dismissTagged()
		controller.choose(0)
		controller.insertBlank()
		await settle()
		expect(controller.getSnapshot().taggedNotice).toBe(false)
	})

	it("refuses to delete every page, and big or empty pictures, without asking the engine", () => {
		const fake = fakeSession(2, () => ({ pages: [], count: 2 }))
		const controller = new PdfPagesController()
		const bound = host(fake)

		controller.bind(bound)
		controller.sync(2)
		controller.remove([0, 1])
		controller.insertImage(new File([], "empty.png"))
		expect(fake.dispatched).toEqual([])
		expect(bound.failed).toEqual(["previewPdfPagesLastPage", "previewPdfPagesInsertImageFailed"])
	})

	it("keeps a page chosen in the rail current while it shows, then follows the view", () => {
		const controller = new PdfPagesController()

		controller.sync(5)
		controller.choose(4)
		// The view cannot bring the last page to the top: it reports the page above it.
		controller.viewerPage(3, page => page === 4 || page === 3)
		expect(controller.getSnapshot().current).toBe(4)
		// Scrolled away: the view's page is the current one again.
		controller.viewerPage(1, page => page === 1)
		expect(controller.getSnapshot().current).toBe(1)
		controller.viewerPage(2, () => true)
		expect(controller.getSnapshot().current).toBe(2)
	})

	it("keeps the selection when a range is extended to a page, and drops it on a plain choice", async () => {
		const controller = new PdfPagesController()

		controller.sync(5)
		controller.select(new Set([1, 2, 3]))
		controller.choose(3)
		expect([...controller.getSnapshot().selected]).toEqual([1, 2, 3])
		await settle()
		controller.choose(2)
		expect(controller.getSnapshot().selected.size).toBe(0)
		expect(controller.targets()).toEqual([2])
	})

	it("asks a second PDF's password again after a wrong one, and inserts nothing when cancelled", async () => {
		let attempts = 0
		const fake = fakeSession(
			2,
			() => ({ pages: [2, 3], count: 4 }),
			(op, args) => {
				if (op !== "attachSource") return Promise.resolve(null)

				attempts++

				return Promise.resolve(
					(args as { password?: string }).password === "secret"
						? { status: "open", source: 7, pageCount: 2 }
						: { status: "password" }
				)
			}
		)
		const controller = new PdfPagesController()

		controller.bind(host(fake))
		controller.sync(2)
		controller.choose(1)
		controller.insertPdf({ kind: "device", file: new File([new Uint8Array(10)], "other.pdf") })
		await vi.waitFor(() => {
			expect(controller.getSnapshot().password).toEqual({ attempt: "initial" })
		})
		controller.answerPassword("nope")
		await vi.waitFor(() => {
			expect(controller.getSnapshot().password).toEqual({ attempt: "retry" })
		})
		controller.answerPassword("secret")
		await vi.waitFor(() => {
			expect(fake.dispatched).toEqual([{ command: "pages.insertFrom", args: { at: 2, source: 7, pages: [0, 1] } }])
		})
		expect(attempts).toBe(3)
		expect(controller.getSnapshot().announcement).toBe("2 pages inserted at position 3")

		controller.insertPdf({ kind: "device", file: new File([new Uint8Array(10)], "locked.pdf") })
		await vi.waitFor(() => {
			expect(controller.getSnapshot().password).not.toBeNull()
		})
		controller.answerPassword(null)
		await settle()
		expect(fake.dispatched).toHaveLength(1)
		controller.sessionChanged(null)
	})
})

describe("new files of pages", () => {
	// An engine holding written files: checkSaved passes, writeOutput streams `bytes` over the save port.
	function copyEngine(bytes: Uint8Array, check: { ok: boolean } = { ok: true }) {
		return async (op: string, args: unknown): Promise<unknown> => {
			switch (op) {
				case "extractBegin":
					return { status: "written", size: bytes.length, pageCount: 1, encryption: "None", flattenedSignatures: 0 }
				case "serveOutput":
					return null
				case "writeOutput": {
					const writer = savePortWriter((args as { port: SavePortEnd }).port)

					writer.announce()
					await writer.write(bytes)
					await writer.close()
					writer.commit()

					return { uploaded: await writer.uploaded }
				}
				case "saveEnd":
					return { state: state(3), heapBytes: 0, history: "kept" }
				default:
					return check
			}
		}
	}

	function verifier(check: { ok: boolean }): () => Promise<PdfEngine> {
		return () =>
			Promise.resolve({
				client: { call: () => Promise.resolve(check) },
				opened: { status: "open" },
				close: () => Promise.resolve({ heapBytes: 0 })
			} as unknown as PdfEngine)
	}

	it("writes, checks and uploads each file in turn, then deletes the extracted pages", async () => {
		const bytes = new Uint8Array([37, 80, 68, 70])
		const fake = fakeSession(3, () => ({ pages: [0], count: 2 }), copyEngine(bytes))
		const uploads: number[][] = []
		const controller = new PdfPagesController()
		const bound = host(fake, {
			openVerifier: verifier({ ok: true }),
			write: async (content, suffix) => {
				const reader = savePortReader(content.port)
				const read: number[] = []

				for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) read.push(...chunk)

				reader.settled(true)
				uploads.push(read)

				return {
					outcome: { status: "success", item: { data: { uuid: "u" } } as DriveItem },
					name: `copy ${suffix(1)}.pdf`
				} as never
			}
		})

		controller.bind(bound)
		controller.sync(3)

		const saved = await controller.makeCopies(
			[
				{ ranges: [{ first: 1, last: 1 }], suffix: () => "a" },
				{ ranges: [{ first: 3, last: 3 }], suffix: () => "b" }
			],
			{ protect: false, deletes: [0], failedKey: "previewPdfExtractFailed" }
		)

		expect(saved).toBe(true)
		expect(uploads).toEqual([
			[37, 80, 68, 70],
			[37, 80, 68, 70]
		])
		expect(bound.copied).toEqual([["copy a.pdf", "copy b.pdf"]])
		expect(fake.calls.filter(call => call.op === "extractBegin").map(call => (call.args as { pages: number[] }).pages)).toEqual([
			[0],
			[2]
		])
		expect(fake.calls.filter(call => call.op === "saveEnd").map(call => (call.args as { outcome: string }).outcome)).toEqual([
			"copied",
			"copied"
		])
		expect(fake.dispatched).toEqual([{ command: "pages.delete", args: { pages: [0] } }])
		expect(controller.getSnapshot().progress).toBeUndefined()
	})

	it("uploads nothing and deletes nothing when a file fails its check", async () => {
		const fake = fakeSession(3, () => ({ pages: [], count: 2 }), copyEngine(new Uint8Array([1])))
		const write = vi.fn()
		const controller = new PdfPagesController()
		const bound = host(fake, { openVerifier: verifier({ ok: false }), write })

		controller.bind(bound)
		controller.sync(3)

		const saved = await controller.makeCopies([{ ranges: [{ first: 1, last: 2 }], suffix: () => "a" }], {
			protect: false,
			deletes: [0, 1],
			failedKey: "previewPdfSplitFailed"
		})

		expect(saved).toBe(false)
		expect(write).not.toHaveBeenCalled()
		expect(bound.failed).toEqual(["previewPdfSplitFailed"])
		expect(fake.calls.filter(call => call.op === "saveEnd").map(call => (call.args as { outcome: string }).outcome)).toEqual(["failed"])
		expect(fake.dispatched).toEqual([])
	})
})

describe("crop geometry", () => {
	it("turns margins drawn on a turned view back to the page's own", () => {
		const margins = { left: 1, top: 2, right: 3, bottom: 4 }

		expect(unrotateMargins(margins, 0)).toEqual(margins)
		expect(unrotateMargins(margins, 90)).toEqual({ top: 3, right: 4, bottom: 1, left: 2 })
		expect(unrotateMargins(margins, 180)).toEqual({ top: 4, right: 1, bottom: 2, left: 3 })
		expect(unrotateMargins(margins, 270)).toEqual({ top: 1, left: 4, bottom: 3, right: 2 })
		expect(unrotateMargins(margins, -90)).toEqual(unrotateMargins(margins, 270))
	})

	it("reads a crop's margins off its page box", () => {
		expect(cropMargins([0, 0, 600, 800], [10.004, 20, 590, 700])).toEqual({ left: 10, top: 20, right: 10, bottom: 100 })
		expect(hasMargins(cropMargins([0, 0, 600, 800], [0, 0, 600, 800]))).toBe(false)
	})

	it("finds where the top-level bookmarks start, once each", async () => {
		const document = {
			numPages: 5,
			getOutline: () =>
				Promise.resolve([
					{ title: "A", dest: [0, { name: "Fit" }], items: [{ title: "A.1", dest: [1, { name: "Fit" }], items: [] }] },
					{ title: "B", dest: [3, { name: "Fit" }], items: [] },
					{ title: "C", dest: [3, { name: "Fit" }], items: [] },
					{ title: "D", dest: null, items: [] }
				])
		}

		expect(await bookmarkStarts(document as never)).toEqual([0, 3])
	})

	it("tells whether a page shows in the scroller", () => {
		let pageBox = { top: 400, bottom: 900 }
		const page = { getBoundingClientRect: () => pageBox }
		const scroller = {
			querySelector: (selector: string) => (selector === '[data-page="2"]' ? page : null),
			getBoundingClientRect: () => ({ top: 0, bottom: 500 })
		} as unknown as HTMLElement

		expect(pageShown(scroller, 1)).toBe(true)
		pageBox = { top: 600, bottom: 900 }
		expect(pageShown(scroller, 1)).toBe(false)
		expect(pageShown(scroller, 4)).toBe(false)
		expect(pageShown(null, 1)).toBe(false)
	})
})
