import { MessageChannel } from "node:worker_threads"
import { randomBytes } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import {
	estimateSavePeak,
	fitsEdit,
	PDF_DESKTOP_MEMORY,
	PDF_HEAP_BASELINE,
	PDF_SAVE_PEAK_FACTOR,
	planSave,
	type PdfMemoryProfile
} from "../../core/pdfedit"
import { PDF_UNSIGNED } from "../../core/pdfedit/signaturePolicy"
import { createSyncRangeBuffer, serveSyncRange, type SyncRangePort } from "../../dom/pdfedit/syncRange"
import { makePdf } from "./fixtures"
import { startEngine, stopEngines, syncPort } from "./harness"
import { budget } from "../timing"

// The memory budget counts what the edits add (pictures, other files' pages) on top of the file, gates every change
// that adds bytes against the size the editor edits, and plans a save from what the heap holds: its display lists and
// store are let go first, so the write runs in the memory the view already took.

afterEach(stopEngines)

const TIMEOUT = budget(60_000)
const MIB = 1024 * 1024

// A PNG of noise (it does not compress): about width × height × 3 bytes.
function noisePng(width: number, height: number): Uint8Array {
	const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false)

	pixmap.getPixels().set(randomBytes(width * height * 3))

	const bytes = pixmap.asPNG().slice()

	pixmap.destroy()

	return bytes
}

// Pages of noise pictures: about `pages` × 1.4 MiB.
function picturePdf(pages: number): Uint8Array {
	const document = new mupdf.PDFDocument()

	for (let index = 0; index < pages; index++) {
		const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 700, 700], false)

		pixmap.getPixels().set(randomBytes(700 * 700 * 3))

		const resources = document.newDictionary()
		const objects = document.newDictionary()

		objects.put("I", document.addImage(new mupdf.Image(pixmap)))
		resources.put("XObject", objects)
		document.insertPage(-1, document.addPage([0, 0, 612, 792], 0, resources, "q 612 0 0 792 0 0 cm /I Do Q"))
		pixmap.destroy()
	}

	const bytes = document.saveToBuffer("compress").asUint8Array().slice()

	document.destroy()

	return bytes
}

function serveBytes(bytes: Uint8Array): { buffer: SharedArrayBuffer; port: SyncRangePort; length: number } {
	const buffer = createSyncRangeBuffer(8, 64 * 1024)
	const channel = new MessageChannel()
	const lifetime = new AbortController()

	serveSyncRange(
		buffer,
		syncPort(channel.port2),
		{ length: bytes.length, read: (start, end) => Promise.resolve(bytes.slice(start, end)) },
		{ lifetime: lifetime.signal, readAhead: 2, onReaderClose: () => lifetime.abort() }
	)

	return { buffer, port: channel.port1 as unknown as SyncRangePort, length: bytes.length }
}

describe("the memory budget", () => {
	it("estimates a save from the file, what the edits added and the heap already held", () => {
		const input = 100 * MIB
		const added = 30 * MIB

		expect(estimateSavePeak(input, false, { heapBytes: 0, addedBytes: added })).toBe(
			PDF_HEAP_BASELINE + added + (input + added) * PDF_SAVE_PEAK_FACTOR
		)
		expect(estimateSavePeak(input, false, { heapBytes: 0, addedBytes: added })).toBeGreaterThan(estimateSavePeak(input, false))
		// A heap already larger holds the save in what it freed.
		expect(estimateSavePeak(MIB, false, { heapBytes: 400 * MIB, addedBytes: 0 })).toBe(400 * MIB)
		expect(fitsEdit(PDF_DESKTOP_MEMORY.editMaxBytes, PDF_DESKTOP_MEMORY)).toBe(true)
		expect(fitsEdit(PDF_DESKTOP_MEMORY.editMaxBytes + 1, PDF_DESKTOP_MEMORY)).toBe(false)

		// A file that fits alone does not once pictures were added to it.
		const plan = (addedBytes: number) =>
			planSave({
				inputBytes: PDF_DESKTOP_MEMORY.editMaxBytes - MIB,
				signatures: PDF_UNSIGNED,
				changes: ["pages"],
				invalidateConfirmed: false,
				poisoned: false,
				memory: PDF_DESKTOP_MEMORY,
				heap: { heapBytes: 0, addedBytes }
			}).refuse

		expect(plan(0)).toBeNull()
		expect(plan(20 * MIB)).toBe("overBudget")
	})

	it(
		"refuses pictures and other files' pages past the size it edits, counting only what is in the document",
		async () => {
			const source = makePdf({ pages: 1 })
			const picture = noisePng(60, 60)
			const memory: PdfMemoryProfile = {
				...PDF_DESKTOP_MEMORY,
				editMaxBytes: source.length + Math.floor(picture.length * 1.5)
			}
			const engine = startEngine(source)

			await engine.open(undefined, memory)

			const insert = () => engine.client.call("dispatch", { command: "pages.insertImage", args: { at: 0, bytes: picture } })

			await insert()
			await expect(insert()).rejects.toMatchObject({ failure: "overBudget" })
			await expect(
				engine.client.call("dispatch", {
					command: "annotations.image",
					args: { page: 0, author: "Ann", rect: [10, 10, 60, 60], image: picture }
				})
			).rejects.toMatchObject({ failure: "overBudget" })

			const other = serveBytes(picturePdf(1))

			await expect(engine.client.call("attachSource", { channel: other }, [other.port])).rejects.toMatchObject({
				failure: "overBudget"
			})

			// Undone, the picture is no longer in the document: another fits.
			await engine.client.call("undo", {})
			await insert()
			expect((await engine.client.call("state", {})).pageCount).toBe(2)
		},
		TIMEOUT
	)

	it(
		"plans a save with what the edits added",
		async () => {
			const source = makePdf({ pages: 1 })
			const picture = noisePng(400, 400)
			const engine = startEngine(source)

			await engine.open()
			await engine.client.call("dispatch", { command: "pages.insertImage", args: { at: 0, bytes: picture } })

			const heap = await engine.client.call("heap", {})
			// Enough for the file alone in the heap as it is, not with the picture written too.
			const memory: PdfMemoryProfile = {
				...PDF_DESKTOP_MEMORY,
				heapBudget: Math.max(heap.heapBytes, estimateSavePeak(source.length, false) + picture.length)
			}
			const begun = await engine.client.call("saveBegin", { inputBytes: source.length, memory, invalidateConfirmed: false })

			expect(begun).toMatchObject({ status: "refused", reason: "overBudget" })
		},
		TIMEOUT
	)

	it(
		"writes in the memory the view took: display lists and store let go first",
		async () => {
			const source = picturePdf(24)
			const engine = startEngine(source)

			await engine.open()

			for (let page = 0; page < 24; page++)
				await engine.client.call("render", { page, scale: 1, rotation: 0, tile: [0, 0, 612, 792], priority: "visible" })

			// A change, so the save writes the pages anew.
			await engine.client.call("dispatch", { command: "pages.rotate", args: { pages: [0], degrees: 90 } })

			const before = (await engine.client.call("heap", {})).heapBytes
			const begun = await engine.client.call("saveBegin", {
				inputBytes: source.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: false
			})

			expect(begun.status).toBe("written")

			const grown = (await engine.client.call("heap", {})).heapBytes - before

			expect(grown).toBeLessThan(source.length)
		},
		TIMEOUT
	)
})
