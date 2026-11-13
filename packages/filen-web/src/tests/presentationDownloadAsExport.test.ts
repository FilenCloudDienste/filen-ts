import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File } from "@filen/sdk-rs"
import type { PresentationRefusal } from "@filen/office/core/presentation"
import type { ConversionReport, PortLike, PresentationEvent, PresentationOpenOptions, SourceSpec } from "@filen/office/dom/presentation"

// Download as of a presentation from the item menus: the deck opened in a presentation worker session of its own, read
// in ranges as the viewer reads it (never whole), converted there and the session closed; the download is the
// package's chunks under the file's name; what the copy holds differently is one warning; a password-protected deck
// asks its password for a .pptx (sealed under it by the worker) and is refused for an .odp before anything is asked.

const mocks = vi.hoisted(() => ({
	pdf: {
		requests: [] as { request: unknown; session: unknown }[],
		refuse: undefined as { reason: PresentationRefusal; detail?: string } | undefined,
		report: undefined as { missing: [string, number][]; refused: [string, number][] } | undefined
	},
	toast: Object.assign(vi.fn(), { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn() }),
	sdk: { openRangePort: vi.fn(), openLinkedRangePortAnon: vi.fn(), cancelPreviewDownload: vi.fn(), downloadFileBytes: vi.fn() },
	downloadBlob: vi.fn<(name: string, blob: Blob) => void>(),
	recordContentVerdict: vi.fn(),
	head: new Uint8Array(),
	pool: {
		opens: [] as { source: SourceSpec; options: PresentationOpenOptions }[],
		closed: 0,
		password: undefined as string | undefined,
		refuse: undefined as PresentationRefusal | undefined,
		convertRefuse: undefined as PresentationRefusal | undefined,
		losses: [] as ConversionReport["losses"],
		converted: [] as string[]
	}
}))

vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("comlink", () => ({ transfer: (value: unknown) => value }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: mocks.sdk }))
vi.mock("@/lib/downloadBlob", () => ({ downloadBlob: mocks.downloadBlob }))
vi.mock("@/features/drive/lib/contentVerdicts", () => ({ recordContentVerdict: mocks.recordContentVerdict }))
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
vi.mock("@/lib/media/rangePort", () => ({
	rangePortReader: () => ({ readRange: () => Promise.resolve(mocks.head), close: vi.fn() })
}))
vi.mock("@/features/presentation/lib/presentationJobs", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/presentation/lib/presentationJobs")>()

	return {
		...actual,
		makePresentationPdf: (session: unknown, request: unknown, options: { onProgress?: (done: number, total: number) => void }) => {
			mocks.pdf.requests.push({ request, session })
			options.onProgress?.(1, 2)

			if (mocks.pdf.refuse !== undefined)
				return Promise.reject(new actual.PresentationJobRefused({ kind: "refused", ...mocks.pdf.refuse }))

			return Promise.resolve({ blob: new Blob(["%PDF-1.7 deck"], { type: "application/pdf" }), report: mocks.pdf.report })
		}
	}
})
vi.mock("@/features/presentation/lib/presentationEngine", async () => {
	const { PresentationCallError } = await import("@filen/office/dom/presentation")
	const { savePortWriter } = await import("@filen/shared/savePort")

	return {
		presentationPool: {
			open(source: SourceSpec, options: PresentationOpenOptions, listener: (event: PresentationEvent) => void) {
				const pool = mocks.pool
				const opened = (): void => {
					listener({
						type: "opened",
						info: { format: options.format, protection: { encrypted: false, writeProtected: false } } as never
					})
				}

				pool.opens.push({ source, options })
				setTimeout(() => {
					if (pool.refuse !== undefined) listener({ type: "error", reason: pool.refuse, message: "" })
					else if (pool.password !== undefined) listener({ type: "error", reason: "needsPassword", message: "" })
					else opened()
				}, 0)

				return {
					unlock(password: string) {
						setTimeout(() => {
							if (password === pool.password) opened()
							else listener({ type: "error", reason: "wrongPassword", message: "" })
						}, 0)
					},
					async freshParts(target: "pptx" | "odp", port: PortLike): Promise<ConversionReport> {
						if (pool.convertRefuse !== undefined) throw new PresentationCallError(pool.convertRefuse, "")

						const writer = savePortWriter(port as never, { lingerMs: 10 })
						const bytes = new TextEncoder().encode(`${target} of ${options.fileName}`)

						writer.announce()
						await writer.write(bytes.subarray(0, 3))
						await writer.write(bytes.subarray(3))
						await writer.close()
						writer.commit()
						pool.converted.push(target)

						return { target, bytes: bytes.length, losses: pool.losses }
					},
					close() {
						pool.closed++
					},
					abort: vi.fn(),
					abortOpen: vi.fn()
				}
			}
		}
	}
})

const { narrowItem } = await import("@/features/drive/lib/item")
const { startDownloadAs } = await import("@/features/drive/lib/downloadAs")
const { currentPasswordAsk } = await import("@/features/drive/lib/downloadAsPassword")
await import("@/lib/i18n")

const CONTEXT = { accessMode: "authed", cacheScope: "authed" } as const

function file(name: string, size = 4096n) {
	return narrowItem({
		uuid: "33333333-3333-3333-3333-333333333333",
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size, key: "key", version: 2 } }
	} satisfies File)
}

async function until(check: () => boolean): Promise<void> {
	for (let turn = 0; turn < 200 && !check(); turn++) await new Promise(resolve => setTimeout(resolve, 0))

	if (!check()) throw new Error("never happened")
}

async function downloaded(): Promise<[string, string, string]> {
	const [name, blob] = mocks.downloadBlob.mock.calls[0] ?? ["", new Blob()]

	return [name, blob.type, await blob.text()]
}

beforeEach(() => {
	vi.clearAllMocks()
	Object.assign(mocks.pool, {
		opens: [],
		closed: 0,
		password: undefined,
		refuse: undefined,
		convertRefuse: undefined,
		losses: [],
		converted: []
	})
	Object.assign(mocks.pdf, { requests: [], refuse: undefined, report: undefined })
	mocks.sdk.openRangePort.mockResolvedValue(undefined)
	mocks.sdk.openLinkedRangePortAnon.mockResolvedValue(undefined)
	mocks.sdk.cancelPreviewDownload.mockResolvedValue(undefined)
})

describe("Download as of a presentation", () => {
	it("converts a PowerPoint deck to .odp in a session of its own, read in ranges, and closes it", async () => {
		await startDownloadAs([file("talk.pptx")], "odp", CONTEXT)

		expect(mocks.pool.opens).toHaveLength(1)

		const [open] = mocks.pool.opens

		expect(open?.source).toMatchObject({ kind: "range", size: 4096, checked: true })
		expect(open?.options).toMatchObject({ format: "pptx", fileName: "talk.pptx", viewOnly: true })
		expect(open?.options.window).toBeUndefined()
		expect(mocks.sdk.downloadFileBytes).not.toHaveBeenCalled()
		expect(await downloaded()).toEqual(["talk.odp", "application/vnd.oasis.opendocument.presentation", "odp of talk.pptx"])
		expect(mocks.pool.closed).toBeGreaterThan(0)
		// The deck's reads end with it.
		expect(mocks.sdk.cancelPreviewDownload).toHaveBeenCalled()
		expect(mocks.toast.warning).not.toHaveBeenCalled()
	})

	it("converts an OpenDocument deck to .pptx and a public link's deck through its own range port", async () => {
		await startDownloadAs([file("talk.otp")], "pptx", { accessMode: "anon", cacheScope: "anon" })

		expect(mocks.sdk.openLinkedRangePortAnon).toHaveBeenCalled()
		expect(mocks.sdk.openRangePort).not.toHaveBeenCalled()
		expect(await downloaded()).toEqual([
			"talk.pptx",
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			"pptx of talk.otp"
		])
	})

	it("says once what the copy holds differently", async () => {
		mocks.pool.losses = [
			{ kind: "smartArt", count: 2 },
			{ kind: "chart", count: 1 }
		]
		await startDownloadAs([file("talk.pptx")], "odp", CONTEXT)

		expect(mocks.toast.warning).toHaveBeenCalledOnce()
		expect(mocks.toast.warning).toHaveBeenCalledWith(
			"Kept differently in the copy: 2 SmartArt diagrams, kept as groups of shapes; 1 chart, left out",
			{ description: "talk.pptx" }
		)
	})

	it("makes a deck's slides a PDF in a jobs worker over a session of its own, and closes it", async () => {
		await startDownloadAs([file("talk.pptx")], "pdf", CONTEXT)

		expect(mocks.pool.opens).toHaveLength(1)
		expect(mocks.pool.opens[0]?.options).toMatchObject({ format: "pptx", fileName: "talk.pptx", viewOnly: true })
		expect(mocks.pdf.requests).toHaveLength(1)
		expect(mocks.pdf.requests[0]?.request).toMatchObject({ layout: "slides", includeHidden: false, protect: false, title: "talk" })
		expect(await downloaded()).toEqual(["talk.pdf", "application/pdf", "%PDF-1.7 deck"])
		expect(mocks.pool.closed).toBeGreaterThan(0)
		expect(mocks.toast.warning).not.toHaveBeenCalled()
	})

	it("says what a deck's PDF left out, as a document's does", async () => {
		mocks.pdf.report = { missing: [], refused: [["untranslated", 3]] }
		await startDownloadAs([file("talk.odp")], "pdf", CONTEXT)

		expect(mocks.toast.warning).toHaveBeenCalledWith("Some content could not be included in the PDF", { description: "talk.odp" })
	})

	it("asks a password-protected deck's password for its PDF, and protects the PDF with it", async () => {
		mocks.pool.password = "tika"

		const done = startDownloadAs([file("secret.pptx")], "pdf", CONTEXT)

		await until(() => currentPasswordAsk() !== null)

		const ask = currentPasswordAsk()

		expect(ask?.purpose).toBe("pdf")
		expect(await ask?.verify("tika", new AbortController().signal)).toBe("accepted")
		await done

		expect(mocks.pdf.requests[0]?.request).toMatchObject({ protect: true })
		expect((await downloaded())[0]).toBe("secret.pdf")
	})

	it("tells a deck whose password cannot protect a PDF so", async () => {
		mocks.pdf.refuse = { reason: "unsupported", detail: "password: mixes text directions" }
		await startDownloadAs([file("talk.pptx")], "pdf", CONTEXT)

		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith("The PDF couldn't be made: this presentation's password can't protect a PDF.", {
			description: "talk.pptx"
		})
	})

	it("refuses a password-protected deck to .odp without asking its password", async () => {
		mocks.pool.password = "tika"
		await startDownloadAs([file("secret.ppt")], "odp", CONTEXT)

		expect(currentPasswordAsk()).toBeNull()
		expect(mocks.pool.converted).toEqual([])
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith(
			"Password-protected files can't be converted to OpenDocument, because the copy would not be protected",
			{ description: "secret.ppt" }
		)
		expect(mocks.pool.closed).toBeGreaterThan(0)
	})

	it("asks a password-protected deck's password for a .pptx, refusing a wrong one", async () => {
		mocks.pool.password = "tika"

		const done = startDownloadAs([file("secret.ppt")], "pptx", CONTEXT)

		await until(() => currentPasswordAsk() !== null)

		const ask = currentPasswordAsk()

		expect(ask?.purpose).toBe("copy")
		expect(await ask?.verify("wrong", new AbortController().signal)).toBe("wrong")
		expect(await ask?.verify("tika", new AbortController().signal)).toBe("accepted")
		await done

		expect(mocks.pool.converted).toEqual(["pptx"])
		expect((await downloaded())[0]).toBe("secret.pptx")
	})

	it("reports a deck the worker refuses to open in the viewer's words, and one it cannot convert", async () => {
		mocks.pool.refuse = "malformed"
		await startDownloadAs([file("broken.pptx")], "odp", CONTEXT)

		expect(mocks.toast.error).toHaveBeenCalledWith("This file is damaged or isn't a presentation.", { description: "broken.pptx" })

		mocks.toast.error.mockClear()
		mocks.pool.refuse = undefined
		mocks.pool.convertRefuse = "encrypted"
		await startDownloadAs([file("sealed.pptx")], "odp", CONTEXT)

		expect(mocks.toast.error).toHaveBeenCalledWith(
			"Password-protected files can't be converted to OpenDocument, because the copy would not be protected",
			{ description: "sealed.pptx" }
		)
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
	})

	it("tells a .pot apart by its first bytes: a gettext template is text, and is recorded so", async () => {
		mocks.head = new TextEncoder().encode('msgid ""\nmsgstr ""\n')
		await startDownloadAs([file("messages.pot")], "pptx", CONTEXT)

		expect(mocks.pool.opens).toEqual([])
		expect(mocks.recordContentVerdict).toHaveBeenCalledWith(
			expect.objectContaining({ name: "messages.pot" }),
			"notPresentationBinary",
			{
				memoryOnly: false
			}
		)
		expect(mocks.toast.error).toHaveBeenCalledWith("This file is a text file, not a PowerPoint template", {
			description: "messages.pot"
		})
	})

	it("opens a .pot that is a 97–2003 template as one", async () => {
		mocks.head = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)
		await startDownloadAs([file("theme.pot")], "odp", CONTEXT)

		expect(mocks.pool.opens[0]?.options.format).toBe("ppt")
		expect(mocks.recordContentVerdict).toHaveBeenCalledWith(expect.anything(), "presentationBinary", { memoryOnly: false })
		expect((await downloaded())[0]).toBe("theme.odp")
	})

	it("converts from the editor's open session where it hands one, reading and opening nothing", async () => {
		const livePresentation = vi.fn(() =>
			Promise.resolve({
				chunks: [new TextEncoder().encode("live")],
				size: 4,
				report: { target: "odp" as const, bytes: 4, losses: [] }
			})
		)

		await startDownloadAs([file("talk.pptx")], "odp", { ...CONTEXT, livePresentation })

		expect(livePresentation).toHaveBeenCalledWith("odp", expect.any(AbortSignal))
		expect(mocks.pool.opens).toEqual([])
		expect(mocks.sdk.openRangePort).not.toHaveBeenCalled()
		expect(await downloaded()).toEqual(["talk.odp", "application/vnd.oasis.opendocument.presentation", "live"])
	})

	it("Cancel ends the session and its reads, downloading nothing", async () => {
		mocks.pool.password = "tika"

		const done = startDownloadAs([file("secret.odp")], "pptx", CONTEXT)

		await until(() => currentPasswordAsk() !== null)

		const options = mocks.toast.loading.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } }

		options.action.onClick()
		await done

		expect(mocks.pool.closed).toBeGreaterThan(0)
		expect(mocks.sdk.cancelPreviewDownload).toHaveBeenCalled()
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})
})
