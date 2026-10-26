import { beforeEach, describe, expect, it, vi } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import { DEFAULT_PAGE_SETUP } from "@filen/office/core/sheet/print"

// Download as from the item menus: the files exported one after another under one toast, read once (an open
// preview's buffer reused), converted and unlocked where the viewers do it, Cancel stopping the read and the worker
// job in flight, a protected file's password asked and then protecting the PDF.

const mocks = vi.hoisted(() => ({
	toast: Object.assign(vi.fn(), { loading: vi.fn(), dismiss: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn() }),
	sdk: { downloadFileBytes: vi.fn(), downloadLinkedFileBytesAnon: vi.fn(), cancelPreviewDownload: vi.fn() },
	joinPreviewBytes: vi.fn(),
	makeDocxPdf: vi.fn(),
	docxProtection: { open: vi.fn() },
	docxLegacy: { open: vi.fn() },
	docxRtf: { open: vi.fn() },
	docxConvert: {
		convert:
			vi.fn<
				(
					bytes: Uint8Array,
					from: string,
					to: string,
					options: { signal: AbortSignal; owned?: boolean; password?: string }
				) => Promise<unknown>
			>()
	},
	openSheet: vi.fn(),
	textToXlsx: vi.fn(),
	makeSheetPdf: vi.fn(),
	downloadBlob: vi.fn<(name: string, blob: Blob) => void>(),
	recordContentVerdict: vi.fn(),
	// The browser's save targets: none by default (the archive is gathered, then downloaded).
	save: {
		fsa: false,
		streams: false,
		saveStreamDownload: vi.fn(),
		triggerSwStreamDownload: vi.fn(),
		discardPickedFile: vi.fn(() => Promise.resolve()),
		assertSwControlled: vi.fn(),
		activeServiceWorker: vi.fn(() => Promise.resolve({}))
	}
}))

vi.mock("sonner", () => ({ toast: mocks.toast }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: mocks.sdk }))
vi.mock("@/features/preview/lib/previewCache", () => ({ joinPreviewBytes: mocks.joinPreviewBytes }))
vi.mock("@/features/preview/lib/docxEngine", () => ({
	docxProtection: mocks.docxProtection,
	docxLegacy: mocks.docxLegacy,
	docxRtf: mocks.docxRtf,
	docxConvert: mocks.docxConvert,
	DOCX_FONT_URLS: {}
}))
vi.mock("@/features/preview/lib/docxPdf", () => ({
	makeDocxPdf: mocks.makeDocxPdf,
	reportDocxPdf: (result: { report: { missing: string[] } }) => (result.report.missing.length > 0 ? "previewDocxPdfMissingGlyphs" : null),
	docxPdfFailure: (_error: unknown, aborted: boolean) => (aborted ? null : "previewDocxPdfFailed")
}))
vi.mock("@/features/spreadsheet/lib/sheetHosts", () => ({
	openSheet: mocks.openSheet,
	textToXlsx: mocks.textToXlsx,
	isTextSheetKind: (kind: string) => kind === "csv" || kind === "tsv" || kind === "tab"
}))
vi.mock("@/features/spreadsheet/save/sheetPdf", () => ({
	makeSheetPdf: mocks.makeSheetPdf,
	sheetPdfMessages: (result: { ok: boolean }) => ({
		warnings: [],
		error: result.ok ? null : { key: "previewSheetPdfFailed", values: {} }
	})
}))
vi.mock("@/lib/downloadBlob", () => ({ downloadBlob: mocks.downloadBlob }))
vi.mock("@/features/drive/lib/contentVerdicts", () => ({ recordContentVerdict: mocks.recordContentVerdict }))
vi.mock("@/features/drive/lib/saveDownload", () => ({
	isFsaAvailable: () => mocks.save.fsa,
	canTransferStreams: () => mocks.save.streams,
	isPickerCancelled: (error: unknown) => error instanceof Error && error.name === "AbortError",
	saveStreamDownload: mocks.save.saveStreamDownload,
	triggerSwStreamDownload: mocks.save.triggerSwStreamDownload,
	discardPickedFile: mocks.save.discardPickedFile,
	assertSwControlled: mocks.save.assertSwControlled,
	activeServiceWorker: mocks.save.activeServiceWorker
}))
vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

import { ZipArchive, bytesSource } from "@filen/office/core/opc"
import { ErrorWithDTO, asErrorDTO } from "@/lib/sdk/errors"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { startDownloadAs } from "@/features/drive/lib/downloadAs"
import { currentPasswordAsk } from "@/features/drive/lib/downloadAsPassword"
import { browserLanguage, sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"
import "@/lib/i18n"

const CONTEXT = { accessMode: "authed", cacheScope: "authed" } as const
const COMPOUND = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])

function file(name: string, uuid: UuidStr = "33333333-3333-3333-3333-333333333333"): DriveItem {
	return narrowItem({
		uuid,
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 10n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 10n, key: "key", version: 2 } }
	} satisfies File)
}

function pdf(text = "%PDF"): { blob: Blob; report: { missing: []; refused: [] } } {
	return { blob: new Blob([text]), report: { missing: [], refused: [] } }
}

// The one archive a bulk run downloaded: its name and each entry's name and text.
async function downloadedZip(): Promise<{ name: string; entries: [string, string][] }> {
	expect(mocks.downloadBlob).toHaveBeenCalledOnce()

	const [name, blob] = mocks.downloadBlob.mock.calls[0] ?? ["", new Blob()]
	const archive = await ZipArchive.open(bytesSource(new Uint8Array(await blob.arrayBuffer())))
	const entries: [string, string][] = []

	for (const entry of archive.entries) entries.push([entry.name, new TextDecoder().decode(await archive.read(entry))])

	return { name, entries }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})

	return { promise, resolve, reject }
}

async function until(check: () => boolean): Promise<void> {
	for (let turn = 0; turn < 200 && !check(); turn++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}

	if (!check()) {
		throw new Error("never happened")
	}
}

// The Cancel the progress toast offers.
function cancelAction(): () => void {
	const options = mocks.toast.loading.mock.calls.at(-1)?.[1] as { action: { onClick: () => void } } | undefined

	if (options === undefined) {
		throw new Error("no progress toast")
	}

	return options.action.onClick
}

beforeEach(() => {
	mocks.save.fsa = false
	mocks.save.streams = false
	mocks.joinPreviewBytes.mockResolvedValue(undefined)
	mocks.sdk.downloadFileBytes.mockImplementation(() => Promise.resolve(ZIP.slice()))
	mocks.makeDocxPdf.mockImplementation(() => Promise.resolve(pdf()))
})

describe("Download as ▸ PDF of documents", () => {
	it("exports a single file and downloads it as <name>.pdf", async () => {
		await startDownloadAs([file("a.docx")], "pdf", CONTEXT)

		expect(mocks.downloadBlob.mock.calls.map(call => call[0])).toEqual(["a.pdf"])
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("exports several files one after another under one toast and downloads them as one zip, as Download does", async () => {
		const first = deferred<ReturnType<typeof pdf>>()

		mocks.makeDocxPdf.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => Promise.resolve(pdf("%PDF b")))

		const done = startDownloadAs([file("a.docx", "11111111-1111-1111-1111-111111111111"), file("b.odt")], "pdf", CONTEXT)

		await until(() => mocks.makeDocxPdf.mock.calls.length === 1)
		// The second file is not read while the first is exported.
		expect(mocks.sdk.downloadFileBytes).toHaveBeenCalledTimes(1)
		first.resolve(pdf("%PDF a"))
		await done

		expect(mocks.sdk.downloadFileBytes).toHaveBeenCalledTimes(2)
		expect(await downloadedZip()).toEqual({
			name: "Filen.zip",
			entries: [
				["a.pdf", "%PDF a"],
				["b.pdf", "%PDF b"]
			]
		})
		expect(mocks.makeDocxPdf.mock.calls[1]?.[0]).toMatchObject({ kind: "file", format: "odt" })

		const ids = new Set(mocks.toast.loading.mock.calls.map(call => (call[1] as { id: string }).id))

		expect(ids.size).toBe(1)
		expect(mocks.toast.loading.mock.calls.map(call => (call[1] as { description: string }).description)).toContain("b.odt (2 of 2)")
		expect(mocks.toast.dismiss).toHaveBeenCalledWith([...ids][0])
		expect(mocks.toast.error).not.toHaveBeenCalled()
		expect(mocks.toast.warning).not.toHaveBeenCalled()
	})

	it("keeps both PDFs when two files of a bulk run share a name", async () => {
		mocks.docxRtf.open.mockResolvedValueOnce({
			kind: "opened",
			document: { take: () => Promise.resolve(ZIP.slice()), release: vi.fn() }
		})
		await startDownloadAs([file("a.docx"), file("A.odt"), file("a.rtf")], "pdf", CONTEXT)

		expect((await downloadedZip()).entries.map(([name]) => name)).toEqual(["a.pdf", "A (2).pdf", "a (3).pdf"])
	})

	it("reuses the buffer an open preview holds instead of downloading the file again, and hands the worker a copy", async () => {
		const held = ZIP.slice()

		mocks.joinPreviewBytes.mockResolvedValue(held)
		await startDownloadAs([file("a.docx")], "pdf", CONTEXT)

		expect(mocks.sdk.downloadFileBytes).not.toHaveBeenCalled()
		expect(mocks.makeDocxPdf.mock.calls[0]?.[0]).toMatchObject({ kind: "file", bytes: held, owned: false })
	})

	it("hands its own read to the worker as it is (no copy), and reads a public link's file as its viewer does", async () => {
		await startDownloadAs([file("a.docx")], "pdf", CONTEXT)

		expect(mocks.makeDocxPdf.mock.calls[0]?.[0]).toMatchObject({ kind: "file", owned: true })

		mocks.sdk.downloadLinkedFileBytesAnon.mockResolvedValue(ZIP.slice())
		await startDownloadAs([file("a.docx")], "pdf", { accessMode: "anon", cacheScope: null })

		expect(mocks.sdk.downloadLinkedFileBytesAnon).toHaveBeenCalledTimes(1)
		expect(mocks.joinPreviewBytes).toHaveBeenLastCalledWith(null, "33333333-3333-3333-3333-333333333333")
	})

	it("Cancel stops the download in flight and skips the remaining files, saying nothing", async () => {
		const read = deferred<Uint8Array>()

		mocks.sdk.downloadFileBytes.mockImplementationOnce(() => read.promise)

		const done = startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT)

		await until(() => mocks.sdk.downloadFileBytes.mock.calls.length === 1)
		cancelAction()()

		const token = mocks.sdk.downloadFileBytes.mock.calls[0]?.[1] as string

		expect(mocks.sdk.cancelPreviewDownload).toHaveBeenCalledWith(token)
		read.reject(Object.assign(new Error("Cancelled"), { name: "Cancelled" }))
		await done

		expect(mocks.sdk.downloadFileBytes).toHaveBeenCalledTimes(1)
		expect(mocks.makeDocxPdf).not.toHaveBeenCalled()
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).not.toHaveBeenCalled()
		expect(mocks.toast.dismiss).toHaveBeenCalled()
	})

	it("Cancel aborts the worker job in flight", async () => {
		let signal: AbortSignal | undefined

		mocks.makeDocxPdf.mockImplementationOnce(
			(_source: unknown, _name: string, make: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signal = make.signal
					make.signal.addEventListener("abort", () => {
						reject(new Error("aborted"))
					})
				})
		)

		const done = startDownloadAs([file("a.docx")], "pdf", CONTEXT)

		await until(() => signal !== undefined)
		cancelAction()()
		await done

		expect(signal?.aborted).toBe(true)
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("reports a file that fails by its name", async () => {
		mocks.makeDocxPdf.mockImplementationOnce(() => Promise.reject(new Error("layout")))
		await startDownloadAs([file("a.docx")], "pdf", CONTEXT)

		expect(mocks.toast.error).toHaveBeenCalledWith("The PDF could not be made", { description: "a.docx" })
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
	})

	it("goes on past a file that fails and reports every file's outcome once, after the run, never over its Cancel", async () => {
		mocks.makeDocxPdf
			.mockImplementationOnce(() => Promise.reject(new Error("layout")))
			.mockImplementationOnce(() => Promise.resolve(pdf()))
			.mockImplementationOnce(() => Promise.reject(new Error("layout")))
		await startDownloadAs([file("a.docx"), file("b.docx"), file("c.docx")], "pdf", CONTEXT)

		expect((await downloadedZip()).entries.map(([name]) => name)).toEqual(["b.pdf"])
		expect(mocks.toast.error).toHaveBeenCalledOnce()
		expect(mocks.toast.error).toHaveBeenCalledWith("2 of 3 files could not be converted", {
			description: "a.docx: The PDF could not be made\nc.docx: The PDF could not be made",
			classNames: { description: "whitespace-pre-line" }
		})
		// Shown once the progress toast (and its Cancel) is gone.
		expect(mocks.toast.error.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.toast.dismiss.mock.invocationCallOrder.at(-1) ?? 0)
	})

	it("lists the files whose PDF lacks something too, after those that failed", async () => {
		mocks.makeDocxPdf
			.mockImplementationOnce(() => Promise.reject(new Error("layout")))
			.mockImplementationOnce(() => Promise.resolve({ blob: new Blob(["%PDF"]), report: { missing: ["Z"], refused: [] } }))
		await startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT)

		const description = (mocks.toast.error.mock.calls[0]?.[1] as { description: string }).description

		expect(description.split("\n")).toEqual([
			"a.docx: The PDF could not be made",
			"b.docx: Some characters could not be drawn in the PDF"
		])
	})

	it("lists at most a few files in its report and counts the rest", async () => {
		mocks.makeDocxPdf.mockImplementation(() => Promise.reject(new Error("layout")))
		await startDownloadAs(
			["a", "b", "c", "d", "e", "f", "g"].map(name => file(`${name}.docx`)),
			"pdf",
			CONTEXT
		)

		expect(mocks.downloadBlob).not.toHaveBeenCalled()

		const description = (mocks.toast.error.mock.calls[0]?.[1] as { description: string }).description

		expect(mocks.toast.error.mock.calls[0]?.[0]).toBe("7 of 7 files could not be converted")
		expect(description.split("\n")).toHaveLength(6)
		expect(description.split("\n").at(-1)).toBe("And 2 more")
	})

	it("refuses a .dot that is a text file (a Graphviz graph) as not a document, and records what it is", async () => {
		mocks.sdk.downloadFileBytes.mockResolvedValueOnce(new TextEncoder().encode("digraph { a -> b }"))
		await startDownloadAs([file("graph.dot")], "pdf", CONTEXT)

		expect(mocks.makeDocxPdf).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith("This file is a text file, not a Word document", { description: "graph.dot" })
		expect(mocks.recordContentVerdict).toHaveBeenCalledWith(
			expect.objectContaining({ uuid: "33333333-3333-3333-3333-333333333333", name: "graph.dot" }),
			"notWordBinary",
			{ memoryOnly: false }
		)
	})

	it("exports a .dot that is a Word 97–2003 template", async () => {
		mocks.sdk.downloadFileBytes.mockResolvedValueOnce(COMPOUND.slice())
		mocks.docxProtection.open.mockResolvedValueOnce({ kind: "plain" })
		mocks.docxLegacy.open.mockResolvedValueOnce({
			kind: "converted",
			document: { take: () => Promise.resolve(ZIP.slice()), release: vi.fn() }
		})
		await startDownloadAs([file("letter.dot")], "pdf", CONTEXT)

		expect(mocks.recordContentVerdict).not.toHaveBeenCalled()
		expect(mocks.downloadBlob).toHaveBeenCalledWith("letter.pdf", expect.any(Blob))
	})

	it("a password-protected document asks its password, refuses a wrong one, then protects the PDF with it", async () => {
		const unlocked = { release: vi.fn() }
		const locked = {
			unlock: vi.fn((password: string) =>
				Promise.resolve(password === "right" ? { ok: true, document: unlocked } : { ok: false, reason: "wrongPassword" })
			),
			dispose: vi.fn()
		}

		mocks.sdk.downloadFileBytes.mockResolvedValue(COMPOUND.slice())
		mocks.docxProtection.open.mockResolvedValue({ kind: "needsPassword", locked })

		const done = startDownloadAs([file("secret.docx")], "pdf", CONTEXT)

		await until(() => currentPasswordAsk() !== null)

		const ask = currentPasswordAsk()

		expect(ask?.name).toBe("secret.docx")
		expect(await ask?.verify("wrong", new AbortController().signal)).toBe("wrong")
		expect(await ask?.verify("right", new AbortController().signal)).toBe("accepted")
		await done

		expect(currentPasswordAsk()).toBeNull()
		expect(mocks.makeDocxPdf).toHaveBeenCalledWith(
			{ kind: "unlocked", document: unlocked },
			"secret.docx",
			expect.objectContaining({ password: "right" })
		)
		// Its dispose would release the unlocked document too.
		expect(locked.dispose).not.toHaveBeenCalled()
		expect(mocks.downloadBlob).toHaveBeenCalledWith("secret.pdf", expect.any(Blob))
	})

	it("a password a PDF cannot take is refused before the file is unlocked", async () => {
		const locked = { unlock: vi.fn(), dispose: vi.fn() }

		mocks.sdk.downloadFileBytes.mockResolvedValue(COMPOUND.slice())
		mocks.docxProtection.open.mockResolvedValue({ kind: "needsPassword", locked })

		const done = startDownloadAs([file("secret.docx")], "pdf", CONTEXT)

		await until(() => currentPasswordAsk() !== null)
		expect(await currentPasswordAsk()?.verify("\u0007", new AbortController().signal)).toBe("aborted")
		await done

		expect(locked.unlock).not.toHaveBeenCalled()
		expect(locked.dispose).toHaveBeenCalledOnce()
		expect(mocks.toast.error).toHaveBeenCalledWith("The PDF could not be made: this document's password cannot protect a PDF", {
			description: "secret.docx"
		})
	})

	it("a prompt let go skips that file quietly and the next one is still exported", async () => {
		const locked = { unlock: vi.fn(), dispose: vi.fn() }

		mocks.sdk.downloadFileBytes.mockResolvedValueOnce(COMPOUND.slice())
		mocks.docxProtection.open.mockResolvedValue({ kind: "needsPassword", locked })

		const done = startDownloadAs([file("secret.docx"), file("open.docx")], "pdf", CONTEXT)

		await until(() => currentPasswordAsk() !== null)
		currentPasswordAsk()?.settle(false)
		await done

		expect(locked.dispose).toHaveBeenCalledOnce()
		expect(mocks.toast.error).not.toHaveBeenCalled()
		expect((await downloadedZip()).entries.map(([name]) => name)).toEqual(["open.pdf"])
	})

	it("Cancel while the prompt shows closes it and ends the export", async () => {
		const locked = { unlock: vi.fn(), dispose: vi.fn() }

		mocks.sdk.downloadFileBytes.mockResolvedValue(COMPOUND.slice())
		mocks.docxProtection.open.mockResolvedValue({ kind: "needsPassword", locked })

		const done = startDownloadAs([file("secret.docx"), file("next.docx")], "pdf", CONTEXT)

		await until(() => currentPasswordAsk() !== null)
		cancelAction()()
		await done

		expect(currentPasswordAsk()).toBeNull()
		expect(locked.dispose).toHaveBeenCalledOnce()
		expect(mocks.sdk.downloadFileBytes).toHaveBeenCalledTimes(1)
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
	})

	it("a Word 97–2003 document is converted in the document worker first, then laid out from its package", async () => {
		const converted = ZIP.slice()
		const document = { take: vi.fn(() => Promise.resolve(converted)), release: vi.fn() }

		mocks.sdk.downloadFileBytes.mockResolvedValue(COMPOUND.slice())
		mocks.docxProtection.open.mockResolvedValue({ kind: "plain" })
		mocks.docxLegacy.open.mockResolvedValue({ kind: "converted", document })
		await startDownloadAs([file("old.doc")], "pdf", CONTEXT)

		expect(document.release).toHaveBeenCalledOnce()
		expect(mocks.makeDocxPdf.mock.calls[0]?.[0]).toEqual({ kind: "file", bytes: converted, owned: true })
		expect(mocks.downloadBlob).toHaveBeenCalledWith("old.pdf", expect.any(Blob))
	})

	it("a Word 97–2003 document the reader refuses is reported in the viewer's words", async () => {
		mocks.sdk.downloadFileBytes.mockResolvedValue(COMPOUND.slice())
		mocks.docxProtection.open.mockResolvedValue({ kind: "plain" })
		mocks.docxLegacy.open.mockResolvedValue({ kind: "refused", refusal: { reason: "legacyVersion" } })
		await startDownloadAs([file("old.doc")], "pdf", CONTEXT)

		expect(mocks.makeDocxPdf).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith(expect.any(String), { description: "old.doc" })
	})

	it("an RTF document is read into its package in the document worker first", async () => {
		const docx = ZIP.slice()
		// One equation the package leaves out: the PDF's report counts it.
		const document = { take: vi.fn(() => Promise.resolve(docx)), release: vi.fn(), untranslated: 1 }

		mocks.docxRtf.open.mockResolvedValue({ kind: "opened", document })
		await startDownloadAs([file("letter.rtf")], "pdf", CONTEXT)

		expect(document.release).toHaveBeenCalledOnce()
		expect(mocks.makeDocxPdf.mock.calls[0]?.[0]).toEqual({ kind: "file", bytes: docx, owned: true, untranslated: 1 })
	})
})

// A picked file that records what is written into it.
function pickedFile() {
	const chunks: Uint8Array[] = []
	const writable = {
		closed: false,
		write: vi.fn((chunk: Uint8Array) => {
			chunks.push(chunk.slice())

			return Promise.resolve()
		}),
		close: vi.fn(() => {
			writable.closed = true

			return Promise.resolve()
		})
	}

	return {
		save: { kind: "fsa", handle: {}, writable },
		writable,
		written: () => chunks.reduce((sum, chunk) => sum + chunk.length, 0),
		async entries(): Promise<string[]> {
			const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
			let at = 0

			for (const chunk of chunks) {
				joined.set(chunk, at)
				at += chunk.length
			}

			const archive = await ZipArchive.open(bytesSource(joined))

			return archive.entries.map(entry => entry.name)
		}
	}
}

describe("Download as ▸ PDF of several files, saved as the drive's Download saves them", () => {
	it("streams each PDF into the picked file as it is made, the next file started only once it is written", async () => {
		const file1 = pickedFile()

		mocks.save.fsa = true
		mocks.save.saveStreamDownload.mockResolvedValue(file1.save)

		const big = "%PDF " + "x".repeat(200_000)
		let writtenWhenSecondStarted = -1

		mocks.makeDocxPdf
			.mockImplementationOnce(() => Promise.resolve(pdf(big)))
			.mockImplementationOnce(() => {
				writtenWhenSecondStarted = file1.written()

				return Promise.resolve(pdf("%PDF b"))
			})

		await startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT)

		// Asked for where to save before anything was read.
		expect(mocks.save.saveStreamDownload).toHaveBeenCalledWith("Filen.zip")
		expect(mocks.save.saveStreamDownload.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.sdk.downloadFileBytes.mock.invocationCallOrder[0] ?? 0
		)
		expect(writtenWhenSecondStarted).toBeGreaterThan(big.length)
		expect(file1.writable.closed).toBe(true)
		expect(await file1.entries()).toEqual(["a.pdf", "b.pdf"])
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
	})

	it("does nothing when the save picker is dismissed", async () => {
		mocks.save.fsa = true
		mocks.save.saveStreamDownload.mockRejectedValue(Object.assign(new Error("dismissed"), { name: "AbortError" }))
		await startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT)

		expect(mocks.sdk.downloadFileBytes).not.toHaveBeenCalled()
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("Cancel leaves no archive: the picked file is discarded, never finished", async () => {
		const file1 = pickedFile()
		const second = deferred<ReturnType<typeof pdf>>()

		mocks.save.fsa = true
		mocks.save.saveStreamDownload.mockResolvedValue(file1.save)
		mocks.makeDocxPdf
			.mockImplementationOnce(() => Promise.resolve(pdf()))
			.mockImplementationOnce(
				(_source: unknown, _name: string, make: { signal: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						make.signal.addEventListener("abort", () => {
							reject(new Error("aborted"))
						})
						void second.promise
					})
			)

		const done = startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT)

		await until(() => mocks.makeDocxPdf.mock.calls.length === 2)
		cancelAction()()
		await done

		expect(file1.writable.closed).toBe(false)
		expect(mocks.save.discardPickedFile).toHaveBeenCalledWith(file1.save)
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("saves no archive when no file gave a PDF, and reports them", async () => {
		const file1 = pickedFile()

		mocks.save.fsa = true
		mocks.save.saveStreamDownload.mockResolvedValue(file1.save)
		mocks.makeDocxPdf.mockImplementation(() => Promise.reject(new Error("layout")))
		await startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT)

		expect(file1.writable.write).not.toHaveBeenCalled()
		expect(mocks.save.discardPickedFile).toHaveBeenCalledWith(file1.save)
		expect(mocks.toast.error).toHaveBeenCalledWith("2 of 2 files could not be converted", expect.anything())
	})

	function swSave(): void {
		mocks.save.streams = true
		mocks.save.saveStreamDownload.mockResolvedValue({ kind: "sw", id: "sw-1", url: "/sw/sw-1", name: "Filen.zip" })
		// Each PDF larger than the stream's room for one chunk: a write waits for the browser to read.
		mocks.makeDocxPdf.mockImplementation(() => Promise.resolve(pdf("%PDF".padEnd(200_000, "x"))))
	}

	// Settles, or says it hung.
	function settled(run: Promise<void>): Promise<string> {
		return Promise.race([
			run.then(() => "settled"),
			new Promise<string>(resolve =>
				setTimeout(() => {
					resolve("hung")
				}, 3000)
			)
		])
	}

	it("fails fast with the reload message on a page the service worker does not control, reading nothing", async () => {
		swSave()
		mocks.save.assertSwControlled.mockImplementationOnce(() => {
			throw new Error("downloads need the page reloaded")
		})

		expect(await settled(startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT))).toBe("settled")
		expect(mocks.save.saveStreamDownload).not.toHaveBeenCalled()
		expect(mocks.sdk.downloadFileBytes).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith("downloads need the page reloaded")
	})

	it("ends the run and says why when the service worker's download fails after a write is waiting", async () => {
		swSave()
		mocks.save.triggerSwStreamDownload.mockImplementation(
			() =>
				new Promise((_resolve, reject) =>
					setTimeout(() => {
						reject(new Error("the download stopped responding"))
					}, 50)
				)
		)

		expect(await settled(startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT))).toBe("settled")
		expect(mocks.toast.error).toHaveBeenCalledOnce()
		expect(mocks.toast.error).toHaveBeenCalledWith("the download stopped responding")
		// The second file is never exported once the download failed.
		expect(mocks.makeDocxPdf).toHaveBeenCalledOnce()
	})

	it("ends the run quietly when the browser's own Cancel stops its download", async () => {
		swSave()
		mocks.save.triggerSwStreamDownload.mockImplementation(
			() =>
				new Promise((_resolve, reject) =>
					setTimeout(() => {
						reject(new ErrorWithDTO({ ...asErrorDTO(new Error("Cancelled")), kind: "Cancelled" }))
					}, 50)
				)
		)

		expect(await settled(startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT))).toBe("settled")
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("Cancel ends the run while the browser does not read (a paused download)", async () => {
		swSave()
		mocks.save.triggerSwStreamDownload.mockImplementation(() => new Promise(() => undefined))

		const run = startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT)

		await until(() => mocks.save.triggerSwStreamDownload.mock.calls.length === 1)
		await new Promise(resolve => setTimeout(resolve, 100))
		cancelAction()()

		expect(await settled(run)).toBe("settled")
		expect(mocks.makeDocxPdf).toHaveBeenCalledOnce()
		expect(mocks.toast.error).not.toHaveBeenCalled()

		// The pipe was aborted: the stream the worker was handed errors.
		const readable = mocks.save.triggerSwStreamDownload.mock.calls[0]?.[2] as ReadableStream<Uint8Array>

		await expect(new Response(readable).arrayBuffer()).rejects.toBeDefined()
	})

	it("streams the archive through the service worker, with no length, starting the download with its first bytes", async () => {
		mocks.save.streams = true
		mocks.save.saveStreamDownload.mockResolvedValue({ kind: "sw", id: "sw-1", url: "/sw/sw-1", name: "Filen.zip" })

		let read: Promise<Uint8Array> | undefined

		mocks.save.triggerSwStreamDownload.mockImplementation(
			(_save: unknown, _id: string, readable: ReadableStream<Uint8Array>, _size: null, _cancel: unknown, started: () => void) => {
				read = new Response(readable).arrayBuffer().then(buffer => new Uint8Array(buffer))
				started()

				return read.then(() => undefined)
			}
		)
		await startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT)

		expect(mocks.save.triggerSwStreamDownload).toHaveBeenCalledOnce()
		expect(mocks.save.triggerSwStreamDownload.mock.calls[0]?.[3]).toBeNull()

		const archive = await ZipArchive.open(bytesSource((await read) ?? new Uint8Array()))

		expect(archive.entries.map(entry => entry.name)).toEqual(["a.pdf", "b.pdf"])
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
	})

	it("reads the next file only once the service worker has taken the download (WebKit stops reads in flight as it navigates)", async () => {
		swSave()

		let started: () => void = () => undefined

		mocks.save.triggerSwStreamDownload.mockImplementation(
			(_save: unknown, _id: string, readable: ReadableStream<Uint8Array>, _size: null, _cancel: unknown, onStarted: () => void) => {
				started = onStarted

				return new Response(readable).arrayBuffer().then(() => undefined)
			}
		)

		const run = startDownloadAs([file("a.docx"), file("b.docx")], "pdf", CONTEXT)

		await until(() => mocks.save.triggerSwStreamDownload.mock.calls.length === 1)
		await new Promise(resolve => setTimeout(resolve, 100))
		expect(mocks.sdk.downloadFileBytes).toHaveBeenCalledOnce()

		started()

		expect(await settled(run)).toBe("settled")
		expect(mocks.sdk.downloadFileBytes).toHaveBeenCalledTimes(2)
	})
})

describe("Download as ▸ PDF of spreadsheets", () => {
	function session() {
		return {
			query: vi.fn((name: string) =>
				Promise.resolve(
					name === "digitWidth"
						? { px: 7 }
						: { setup: DEFAULT_PAGE_SETUP, used: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 } }
				)
			),
			layout: vi.fn(),
			configure: vi.fn(),
			close: vi.fn()
		}
	}

	const info = {
		kind: "xlsx",
		activeSheet: 2,
		sheets: [
			{ id: 1, name: "First", kind: "worksheet", state: "visible" },
			{ id: 2, name: "Shown", kind: "worksheet", state: "visible" }
		],
		date1904: true
	}

	it("prints the sheet the workbook opens on, as the File menu's export does, and closes the session", async () => {
		const opened = session()

		mocks.openSheet.mockResolvedValue({ kind: "opened", session: opened, info })
		mocks.makeSheetPdf.mockResolvedValue({ ok: true, blob: new Blob(["%PDF"]) })
		await startDownloadAs([file("book.xlsx")], "pdf", CONTEXT)

		const request = mocks.makeSheetPdf.mock.calls[0]?.[1] as {
			sheets: { sheet: number }[]
			title: string
			date1904: boolean
			showFormulas: boolean
		}

		expect(mocks.openSheet.mock.calls[0]?.[1]).toMatchObject({ kind: "xlsx" })
		expect(opened.query).toHaveBeenCalledWith("print.settings", { sheet: 2 })
		expect(request.sheets.map(sheet => sheet.sheet)).toEqual([2])
		expect(request).toMatchObject({ title: "book", date1904: true, showFormulas: false })
		// Numbers and dates print in the browser's locale, as the viewer's grid has its session show them.
		expect(opened.configure).toHaveBeenCalledWith({ locale: sheetLocaleOf(browserLanguage()) })
		expect(opened.configure.mock.invocationCallOrder[0]).toBeLessThan(mocks.makeSheetPdf.mock.invocationCallOrder[0] ?? 0)
		expect(opened.close).toHaveBeenCalledOnce()
		expect(mocks.downloadBlob).toHaveBeenCalledWith("book.pdf", expect.any(Blob))
	})

	it("a protected workbook asks its password; the PDF is protected with it", async () => {
		const opened = session()
		const locked = {
			unlock: vi.fn((password: string) =>
				Promise.resolve(password === "right" ? { ok: true, session: opened, info } : { ok: false, reason: "wrongPassword" })
			),
			dispose: vi.fn()
		}

		mocks.openSheet.mockResolvedValue({ kind: "needsPassword", locked })
		mocks.makeSheetPdf.mockResolvedValue({ ok: true, blob: new Blob(["%PDF"]) })

		const done = startDownloadAs([file("book.xlsx")], "pdf", CONTEXT)

		await until(() => currentPasswordAsk() !== null)
		expect(await currentPasswordAsk()?.verify("wrong", new AbortController().signal)).toBe("wrong")
		expect(await currentPasswordAsk()?.verify("right", new AbortController().signal)).toBe("accepted")
		await done

		expect(mocks.makeSheetPdf.mock.calls[0]?.[2]).toMatchObject({ password: "right" })
		expect(locked.dispose).not.toHaveBeenCalled()
		expect(opened.close).toHaveBeenCalledOnce()
	})

	it("a workbook that does not open is reported, and nothing is held for it", async () => {
		mocks.openSheet.mockResolvedValue({ kind: "failed", reason: "malformed", message: "x" })
		await startDownloadAs([file("book.xlsx")], "pdf", CONTEXT)

		expect(mocks.makeSheetPdf).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith(expect.any(String), { description: "book.xlsx" })
	})
})

describe("Download as ▸ another editable format", () => {
	const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

	function converted(text = "converted", lossy: { kind: string; count: number }[] = []) {
		return { kind: "converted", bytes: new TextEncoder().encode(text), lossy }
	}

	async function downloaded(): Promise<[string, string, string]> {
		const [name, blob] = mocks.downloadBlob.mock.calls[0] ?? ["", new Blob()]

		return [name, blob.type, await blob.text()]
	}

	function workbook(answer: unknown) {
		return { query: vi.fn(() => Promise.resolve(answer)), close: vi.fn() }
	}

	it("converts a document in the document worker and downloads it under the new extension and type", async () => {
		mocks.docxConvert.convert.mockResolvedValue(converted("docx bytes"))
		await startDownloadAs([file("notes.odt")], "docx", CONTEXT)

		const [bytes, from, to, options] = mocks.docxConvert.convert.mock.calls[0] ?? []

		expect([from, to]).toEqual(["odt", "docx"])
		// Its own read goes to the worker as it is.
		expect(bytes).toBeInstanceOf(Uint8Array)
		expect(options).toMatchObject({ owned: true })
		expect(await downloaded()).toEqual(["notes.docx", DOCX, "docx bytes"])
		expect(mocks.makeDocxPdf).not.toHaveBeenCalled()
		expect(mocks.toast.warning).not.toHaveBeenCalled()
	})

	it("hands a buffer the preview holds over as a copy", async () => {
		const held = ZIP.slice()

		mocks.joinPreviewBytes.mockResolvedValue(held)
		mocks.docxConvert.convert.mockResolvedValue(converted())
		await startDownloadAs([file("report.docx")], "odt", CONTEXT)

		expect(mocks.docxConvert.convert.mock.calls[0]?.[3]).toMatchObject({ owned: false })
		expect(mocks.sdk.downloadFileBytes).not.toHaveBeenCalled()
		expect((await downloaded())[0]).toBe("report.odt")
	})

	it("says what the converted copy lacks", async () => {
		mocks.docxConvert.convert.mockResolvedValue(converted("x", [{ kind: "chart", count: 2 }]))
		await startDownloadAs([file("report.docx")], "odt", CONTEXT)

		expect(mocks.toast.warning).toHaveBeenCalledWith("Some of this file's content or formatting is not in the converted copy", {
			description: "report.docx"
		})
	})

	it("refuses a password-protected document: its copy could not keep the protection", async () => {
		mocks.docxConvert.convert.mockResolvedValue({ kind: "refused", reason: "encrypted", message: "x" })
		await startDownloadAs([file("secret.docx")], "odt", CONTEXT)

		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith(
			"Password-protected files can't be converted to OpenDocument, because the copy would not be protected",
			{
				description: "secret.docx"
			}
		)
	})

	it("a password-protected Word 97–2003 document asks its password; its .docx is protected with it", async () => {
		mocks.joinPreviewBytes.mockResolvedValue(COMPOUND.slice())
		mocks.docxProtection.open.mockResolvedValue({ kind: "plain" })
		mocks.docxConvert.convert.mockImplementation((_bytes, _from, _to, options) =>
			Promise.resolve(
				options.password === undefined
					? { kind: "refused", reason: "encrypted", message: "x", encryption: "rc4" }
					: options.password === "right"
						? converted("sealed docx")
						: { kind: "refused", reason: "wrongPassword", message: "x" }
			)
		)

		const done = startDownloadAs([file("old.doc")], "docx", CONTEXT)

		await until(() => currentPasswordAsk() !== null)
		expect(currentPasswordAsk()?.purpose).toBe("copy")
		expect(await currentPasswordAsk()?.verify("wrong", new AbortController().signal)).toBe("wrong")
		expect(await currentPasswordAsk()?.verify("right", new AbortController().signal)).toBe("accepted")
		await done

		// The buffer the preview holds is never handed over: the file may be read again with its password.
		expect(mocks.docxConvert.convert.mock.calls.map(call => [call[3].owned === true, call[3].password])).toEqual([
			[false, undefined],
			[false, "wrong"],
			[false, "right"]
		])
		expect(await downloaded()).toEqual(["old.docx", DOCX, "sealed docx"])
	})

	it("refuses a Word 97–2003 document encrypted with a cipher no password opens here, asking nothing", async () => {
		mocks.joinPreviewBytes.mockResolvedValue(COMPOUND.slice())
		mocks.docxConvert.convert.mockResolvedValue({ kind: "refused", reason: "encrypted", message: "x", encryption: "unknown" })
		await startDownloadAs([file("old.doc")], "docx", CONTEXT)

		expect(currentPasswordAsk()).toBeNull()
		expect(mocks.docxProtection.open).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith("This document uses an encryption method Filen can't open.", {
			description: "old.doc"
		})
	})

	it("refuses a password-protected OpenDocument text document to .docx as unsupported encryption, not as an OpenDocument copy", async () => {
		mocks.docxConvert.convert.mockResolvedValue({ kind: "refused", reason: "encrypted", message: "x" })
		await startDownloadAs([file("secret.odt")], "docx", CONTEXT)

		expect(currentPasswordAsk()).toBeNull()
		expect(mocks.toast.error).toHaveBeenCalledWith("This document uses an encryption method Filen can't open.", {
			description: "secret.odt"
		})
	})

	it("refuses an .odt of a password-protected document without asking its password", async () => {
		mocks.joinPreviewBytes.mockResolvedValue(COMPOUND.slice())
		mocks.docxConvert.convert.mockResolvedValue({ kind: "refused", reason: "encrypted", message: "x" })
		await startDownloadAs([file("old.doc")], "odt", CONTEXT)

		expect(currentPasswordAsk()).toBeNull()
		expect(mocks.docxProtection.open).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith(
			"Password-protected files can't be converted to OpenDocument, because the copy would not be protected",
			{ description: "old.doc" }
		)
	})

	it("downloads a .doc that is really a password-protected Word package as it is, still protected", async () => {
		const locked = { dispose: vi.fn() }

		mocks.joinPreviewBytes.mockResolvedValue(COMPOUND.slice())
		mocks.docxConvert.convert.mockResolvedValue({ kind: "refused", reason: "encrypted", message: "x" })
		mocks.docxProtection.open.mockResolvedValue({ kind: "needsPassword", locked })
		await startDownloadAs([file("old.doc")], "docx", CONTEXT)

		const [name, type] = await downloaded()

		expect([name, type]).toEqual(["old.docx", DOCX])
		expect(new Uint8Array(await (mocks.downloadBlob.mock.calls[0]?.[1] ?? new Blob()).arrayBuffer())).toEqual(COMPOUND)
		expect(locked.dispose).toHaveBeenCalledOnce()
		expect(currentPasswordAsk()).toBeNull()
	})

	it("Cancel aborts the conversion in the worker and downloads nothing", async () => {
		const answer = deferred<unknown>()

		mocks.docxConvert.convert.mockReturnValue(answer.promise)

		const done = startDownloadAs([file("letter.rtf")], "odt", CONTEXT)

		await until(() => mocks.docxConvert.convert.mock.calls.length > 0)

		const signal = (mocks.docxConvert.convert.mock.calls[0]?.[3] as { signal: AbortSignal }).signal

		cancelAction()()
		expect(signal.aborted).toBe(true)
		answer.resolve({ kind: "aborted" })
		await done

		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("converts several documents into one zip of the converted files", async () => {
		mocks.docxConvert.convert.mockImplementation(() => Promise.resolve(converted("c")))
		await startDownloadAs([file("a.odt", "33333333-3333-3333-3333-333333333331"), file("b.odt")], "docx", CONTEXT)

		expect((await downloadedZip()).entries.map(([name]) => name)).toEqual(["a.docx", "b.docx"])
	})

	it("converts a workbook on a session of its own and closes it", async () => {
		const opened = workbook({ ok: true, bytes: new TextEncoder().encode("xlsx"), lossy: [{ kind: "formula", count: 3 }] })

		mocks.openSheet.mockResolvedValue({ kind: "opened", session: opened, info: {} })
		await startDownloadAs([file("book.ods")], "xlsx", CONTEXT)

		expect(mocks.openSheet.mock.calls[0]?.[1]).toMatchObject({ kind: "ods" })
		expect(opened.query).toHaveBeenCalledWith(
			"saveAs.format",
			{ format: "xlsx", language: browserLanguage() },
			{ signal: expect.any(AbortSignal) as AbortSignal }
		)
		expect(opened.close).toHaveBeenCalledOnce()
		expect((await downloaded())[0]).toBe("book.xlsx")
		expect(mocks.toast.warning).toHaveBeenCalledWith("3 formulas are kept only as their values", { description: "book.ods" })
	})

	it("says an Excel 97–2003 workbook's copy holds its values alone, as Save as .xlsx does", async () => {
		const opened = workbook({ ok: true, bytes: new TextEncoder().encode("xlsx"), lossy: [{ kind: "valuesOnly", count: 1 }] })

		mocks.openSheet.mockResolvedValue({ kind: "opened", session: opened, info: {} })
		await startDownloadAs([file("book.xls")], "xlsx", CONTEXT)

		expect((await downloaded())[0]).toBe("book.xlsx")
		expect(mocks.toast.warning).toHaveBeenCalledWith(
			"Only the values are in the converted copy: formulas become their results, and formatting, column widths, row heights and named ranges are not kept",
			{ description: "book.xls" }
		)
		expect(mocks.toast.warning).toHaveBeenCalledOnce()
	})

	it("converts to .ods in the user's language", async () => {
		const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-FR"])
		const opened = workbook({ ok: true, bytes: new TextEncoder().encode("ods"), lossy: [] })

		try {
			mocks.openSheet.mockResolvedValue({ kind: "opened", session: opened, info: {} })
			await startDownloadAs([file("book.xlsx")], "ods", CONTEXT)

			expect(opened.query).toHaveBeenCalledWith(
				"saveAs.format",
				{ format: "ods", language: "fr-FR" },
				{ signal: expect.any(AbortSignal) as AbortSignal }
			)
		} finally {
			languages.mockRestore()
		}
	})

	it("downloads an .xls that is really a password-protected workbook package as its .xlsx, still protected", async () => {
		const locked = { scheme: "agile", spinCount: 100_000, unlock: vi.fn(), dispose: vi.fn() }

		mocks.joinPreviewBytes.mockResolvedValue(COMPOUND.slice())
		mocks.openSheet.mockResolvedValue({ kind: "needsPassword", locked })
		await startDownloadAs([file("book.xls")], "xlsx", CONTEXT)

		expect(locked.dispose).toHaveBeenCalledOnce()
		expect(locked.unlock).not.toHaveBeenCalled()
		expect((await downloaded())[0]).toBe("book.xlsx")
		expect(new Uint8Array(await (mocks.downloadBlob.mock.calls[0]?.[1] ?? new Blob()).arrayBuffer())).toEqual(COMPOUND)
	})

	it("a password-protected Excel 97–2003 workbook asks its password; its .xlsx is its sealed Save as .xlsx", async () => {
		const opened = { save: vi.fn(() => Promise.resolve({ ok: true, bytes: new TextEncoder().encode("sealed xlsx") })), close: vi.fn() }
		const locked = {
			scheme: "rc4",
			spinCount: 0,
			unlock: vi.fn((password: string) =>
				Promise.resolve(password === "right" ? { ok: true, session: opened, info: {} } : { ok: false, reason: "wrongPassword" })
			),
			dispose: vi.fn()
		}

		mocks.joinPreviewBytes.mockResolvedValue(COMPOUND.slice())
		mocks.openSheet.mockResolvedValue({ kind: "needsPassword", locked })

		const done = startDownloadAs([file("book.xls")], "xlsx", CONTEXT)

		await until(() => currentPasswordAsk() !== null)
		expect(currentPasswordAsk()?.purpose).toBe("copy")
		expect(await currentPasswordAsk()?.verify("wrong", new AbortController().signal)).toBe("wrong")
		expect(await currentPasswordAsk()?.verify("right", new AbortController().signal)).toBe("accepted")
		await done

		expect(opened.save).toHaveBeenCalledOnce()
		expect(opened.close).toHaveBeenCalledOnce()
		expect(locked.dispose).not.toHaveBeenCalled()
		expect((await downloaded())[0]).toBe("book.xlsx")
		expect(await (mocks.downloadBlob.mock.calls[0]?.[1] ?? new Blob()).text()).toBe("sealed xlsx")
	})

	it("refuses a password-protected Excel 97–2003 workbook to .ods without asking its password", async () => {
		const locked = { scheme: "rc4", spinCount: 0, unlock: vi.fn(), dispose: vi.fn() }

		mocks.joinPreviewBytes.mockResolvedValue(COMPOUND.slice())
		mocks.openSheet.mockResolvedValue({ kind: "needsPassword", locked })
		await startDownloadAs([file("book.xls")], "ods", CONTEXT)

		expect(locked.dispose).toHaveBeenCalledOnce()
		expect(locked.unlock).not.toHaveBeenCalled()
		expect(currentPasswordAsk()).toBeNull()
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
	})

	it("refuses a password-protected workbook without asking its password", async () => {
		const locked = { unlock: vi.fn(), dispose: vi.fn() }

		mocks.openSheet.mockResolvedValue({ kind: "needsPassword", locked })
		await startDownloadAs([file("book.xlsx")], "ods", CONTEXT)

		expect(locked.dispose).toHaveBeenCalledOnce()
		expect(locked.unlock).not.toHaveBeenCalled()
		expect(currentPasswordAsk()).toBeNull()
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
	})

	it("makes a text file's cells a workbook first, then converts that", async () => {
		const text = workbook({ ok: true, bytes: new TextEncoder().encode("cells") })
		const made = workbook({ ok: true, bytes: new TextEncoder().encode("ods"), lossy: [] })

		mocks.openSheet.mockResolvedValueOnce({ kind: "opened", session: text, info: {} })
		mocks.openSheet.mockResolvedValueOnce({ kind: "opened", session: made, info: {} })
		mocks.textToXlsx.mockResolvedValue({ ok: true, bytes: new TextEncoder().encode("xlsx") })
		await startDownloadAs([file("data.csv")], "ods", CONTEXT)

		expect(mocks.openSheet.mock.calls.map(call => (call[1] as { kind: string }).kind)).toEqual(["csv", "xlsx"])
		expect(text.query).toHaveBeenCalledWith("saveAs.cells", {}, { signal: expect.any(AbortSignal) as AbortSignal })
		expect(mocks.textToXlsx).toHaveBeenCalledWith(new TextEncoder().encode("cells"), "data")
		expect(made.query).toHaveBeenCalledWith(
			"saveAs.format",
			{ format: "ods", language: browserLanguage() },
			{ signal: expect.any(AbortSignal) as AbortSignal }
		)
		expect(text.close).toHaveBeenCalledOnce()
		expect(made.close).toHaveBeenCalledOnce()
		expect((await downloaded())[0]).toBe("data.ods")
	})

	it("refuses a text file with more rows than a sheet holds: its copy would leave the rest out", async () => {
		const text = workbook({ ok: false, refusal: { reason: "tooLarge", detail: "incomplete" } })

		mocks.openSheet.mockResolvedValueOnce({ kind: "opened", session: text, info: {} })
		await startDownloadAs([file("data.csv")], "xlsx", CONTEXT)

		expect(mocks.textToXlsx).not.toHaveBeenCalled()
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(text.close).toHaveBeenCalledOnce()
		expect(mocks.toast.error).toHaveBeenCalledWith("This file is too large to convert here", { description: "data.csv" })
	})

	it("converts an editor's open workbook from its session, reading nothing", async () => {
		const live = vi.fn((_format: "xlsx" | "ods", _signal: AbortSignal) =>
			Promise.resolve({ ok: true as const, bytes: new TextEncoder().encode("ods"), lossy: [] })
		)

		await startDownloadAs([file("book.xlsx")], "ods", { ...CONTEXT, live })

		expect(live).toHaveBeenCalledWith("ods", expect.any(AbortSignal))
		expect(mocks.sdk.downloadFileBytes).not.toHaveBeenCalled()
		expect(mocks.openSheet).not.toHaveBeenCalled()
		expect((await downloaded())[0]).toBe("book.ods")
	})

	it("converts an editor's open document as the editor holds it, unsaved edits included, reading nothing", async () => {
		const edited = Uint8Array.of(9, 9, 9)
		const liveFile = vi.fn((_target: "docx" | "odt", _signal: AbortSignal) => Promise.resolve({ kind: "file" as const, bytes: edited }))

		mocks.docxConvert.convert.mockResolvedValue(converted("odt"))
		await startDownloadAs([file("report.docx")], "odt", { ...CONTEXT, liveFile })

		expect(liveFile).toHaveBeenCalledWith("odt", expect.any(AbortSignal))
		expect(mocks.joinPreviewBytes).not.toHaveBeenCalled()
		expect(mocks.sdk.downloadFileBytes).not.toHaveBeenCalled()
		expect(mocks.docxConvert.convert.mock.calls[0]?.slice(0, 3)).toEqual([edited, "docx", "odt"])
		expect(mocks.docxConvert.convert.mock.calls[0]?.[3].owned).toBe(true)
		expect((await downloaded())[0]).toBe("report.odt")
	})

	it("downloads an editor's OpenDocument text document converted where it is held, nothing converted again", async () => {
		const liveFile = vi.fn((_target: "docx" | "odt", _signal: AbortSignal) =>
			Promise.resolve({ kind: "converted" as const, conversion: { kind: "converted" as const, bytes: Uint8Array.of(5), lossy: [] } })
		)

		await startDownloadAs([file("notes.odt")], "docx", { ...CONTEXT, liveFile })

		expect(mocks.docxConvert.convert).not.toHaveBeenCalled()
		expect((await downloaded())[0]).toBe("notes.docx")
	})

	it("converts an editor's RTF document's .docx on to .odt", async () => {
		const liveFile = vi.fn((_target: "docx" | "odt", _signal: AbortSignal) =>
			Promise.resolve({ kind: "file" as const, bytes: Uint8Array.of(4), format: "docx" as const })
		)

		mocks.docxConvert.convert.mockResolvedValue(converted("odt"))
		await startDownloadAs([file("letter.rtf")], "odt", { ...CONTEXT, liveFile })

		expect(mocks.docxConvert.convert.mock.calls[0]?.slice(0, 3)).toEqual([Uint8Array.of(4), "docx", "odt"])
		expect((await downloaded())[0]).toBe("letter.odt")
	})

	it("converts the saved file when the editor holds nothing to write", async () => {
		const liveFile = vi.fn((_target: "docx" | "odt", _signal: AbortSignal) => Promise.resolve({ kind: "saved" as const }))

		mocks.docxConvert.convert.mockResolvedValue(converted("odt"))
		await startDownloadAs([file("report.docx")], "odt", { ...CONTEXT, liveFile })

		expect(mocks.sdk.downloadFileBytes).toHaveBeenCalledOnce()
		expect(mocks.docxConvert.convert.mock.calls[0]?.slice(1, 3)).toEqual(["docx", "odt"])
		expect((await downloaded())[0]).toBe("report.odt")
	})

	it("Cancel during the editor's write ends the run quietly and downloads nothing", async () => {
		const liveFile = vi.fn(
			(_target: "docx" | "odt", signal: AbortSignal) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						const error = new Error("The write was aborted")

						error.name = "AbortError"
						reject(error)
					})
				})
		)
		const done = startDownloadAs([file("report.docx")], "odt", { ...CONTEXT, liveFile })

		await until(() => liveFile.mock.calls.length > 0)
		cancelAction()()
		await done

		expect(liveFile.mock.calls[0]?.[1].aborted).toBe(true)
		expect(mocks.docxConvert.convert).not.toHaveBeenCalled()
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("reports an editor's document its writer cannot write, never converting the saved file instead", async () => {
		const liveFile = vi.fn((_target: "docx" | "odt", _signal: AbortSignal) => Promise.reject(new Error("refused")))

		await startDownloadAs([file("letter.rtf")], "docx", { ...CONTEXT, liveFile })

		expect(mocks.docxConvert.convert).not.toHaveBeenCalled()
		expect(mocks.sdk.downloadFileBytes).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith("This file could not be converted", { description: "letter.rtf" })
	})

	it("Cancel while an editor's workbook converts ends the run quietly and downloads nothing", async () => {
		const answer = deferred<{ ok: true; bytes: Uint8Array; lossy: [] }>()
		const live = vi.fn((_format: "xlsx" | "ods", _signal: AbortSignal) => answer.promise)
		const done = startDownloadAs([file("data.csv")], "xlsx", { ...CONTEXT, live })

		await until(() => live.mock.calls.length > 0)
		cancelAction()()
		answer.resolve({ ok: true, bytes: Uint8Array.of(1), lossy: [] })
		await done

		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).not.toHaveBeenCalled()
	})

	it("ends quietly where the editor's open entry cannot be committed (the sheet says why)", async () => {
		const live = vi.fn((_format: "xlsx" | "ods", _signal: AbortSignal) =>
			Promise.resolve({ ok: false as const, reason: "uncommitted", message: "x" })
		)

		await startDownloadAs([file("data.csv")], "ods", { ...CONTEXT, live })

		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).not.toHaveBeenCalled()
		expect(mocks.toast.warning).not.toHaveBeenCalled()
	})

	it("carries what an editor's document's .docx lacks into its .odt's report", async () => {
		const liveFile = vi.fn((_target: "docx" | "odt", _signal: AbortSignal) =>
			Promise.resolve({
				kind: "file" as const,
				bytes: Uint8Array.of(4),
				format: "docx" as const,
				lossy: [{ kind: "rtfShape" as const, count: 3 }]
			})
		)

		mocks.docxConvert.convert.mockResolvedValue(converted("odt"))
		await startDownloadAs([file("letter.rtf")], "odt", { ...CONTEXT, liveFile })

		expect(mocks.toast.warning).toHaveBeenCalledWith("Some of this file's content or formatting is not in the converted copy", {
			description: "letter.rtf"
		})
	})

	it("never converts a file to its own format", async () => {
		await startDownloadAs([file("report.docx")], "docx", CONTEXT)

		expect(mocks.docxConvert.convert).not.toHaveBeenCalled()
		expect(mocks.downloadBlob).not.toHaveBeenCalled()
		expect(mocks.toast.error).toHaveBeenCalledWith("This file could not be converted", { description: "report.docx" })
	})
})
