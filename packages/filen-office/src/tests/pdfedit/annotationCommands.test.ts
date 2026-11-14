import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit"
import type { PdfAnnotationInfo } from "../../core/pdfedit/annotations"
import type { PdfEngineClient } from "../../dom/pdfedit/client"
import { makePdf } from "./fixtures"
import { startEngine, stopEngines, upload } from "./harness"
import { budget } from "../timing"

// The annotation commands and reads through the engine: one journal step per command, refusals for malformed
// arguments and locked annotations, and a saved file read back by MuPDF and pdf.js.

afterEach(stopEngines)

const TIMEOUT = budget(30_000)
const AUTHOR = "Ann Lee"

async function annotations(client: PdfEngineClient, page = 0): Promise<readonly PdfAnnotationInfo[]> {
	const read = await client.call("annotations", { pages: [page] })

	return read[0]?.annotations ?? []
}

function pdfPage(document: mupdf.PDFDocument, index: number): mupdf.PDFPage {
	const page = document.loadPage(index)

	if (!(page instanceof mupdf.PDFPage)) throw new Error("not a PDF page")

	return page
}

// A PDF with a locked square and a document attachment, made with MuPDF.
function lockedPdf(): Uint8Array {
	const document = mupdf.Document.openDocument(makePdf({ pages: 1 }), "application/pdf").asPDF()

	if (document === null) throw new Error("not a PDF")

	const page = pdfPage(document, 0)
	const square = page.createAnnotation("Square")

	square.setRect([300, 300, 400, 400])
	square.setFlags(128)
	square.setAuthor("Someone")
	square.update()
	document.insertEmbeddedFile(
		"notes.txt",
		document.addEmbeddedFile("notes.txt", "text/plain", new TextEncoder().encode("hi"), new Date(), new Date())
	)

	const bytes = document.saveToBuffer("compress").asUint8Array().slice()

	document.destroy()

	return bytes
}

function png(): Uint8Array {
	const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 10], false)

	pixmap.clear(128)

	const bytes = pixmap.asPNG().slice()

	pixmap.destroy()

	return bytes
}

describe("annotation commands in the engine", () => {
	it(
		"makes every kind of annotation as one undoable step and reports what it made",
		async () => {
			const source = makePdf({ pages: 2 })
			const engine = startEngine(source)

			await engine.open()

			const box = await engine.client.call("dispatch", {
				command: "annotations.textBox",
				args: {
					page: 0,
					author: AUTHOR,
					rect: [72, 200, 272, 240],
					text: "Hello",
					font: "Helv",
					size: 12,
					color: [0, 0, 0],
					align: "left"
				}
			})

			expect(box.pages).toEqual([0])
			expect(box.created?.page).toBe(0)
			expect(box.state).toMatchObject({ dirty: true, undoLabel: "annotations.textBox", changes: ["annotate"] })

			const listed = await annotations(engine.client)

			expect(listed).toHaveLength(1)
			expect(listed[0]).toMatchObject({ id: box.created?.id, type: "FreeText", text: "Hello", author: AUTHOR, locked: false })

			// Ink: the drawing, then a stroke added to it, each its own step.
			const ink = await engine.client.call("dispatch", {
				command: "annotations.ink",
				args: {
					page: 0,
					author: AUTHOR,
					strokes: [
						[
							[100, 300],
							[150, 320]
						]
					],
					color: [1, 0, 0],
					width: 2
				}
			})
			const inkId = ink.created?.id ?? -1

			await engine.client.call("dispatch", {
				command: "annotations.inkStroke",
				args: {
					page: 0,
					id: inkId,
					stroke: [
						[100, 340],
						[160, 360]
					]
				}
			})

			const drawn = (await annotations(engine.client)).find(info => info.id === inkId)

			expect(drawn?.rect[3]).toBeGreaterThan(355)
			await engine.client.call("undo", {})

			const oneStroke = (await annotations(engine.client)).find(info => info.id === inkId)

			// The second stroke went, the drawing stayed.
			expect(oneStroke?.rect[3]).toBeLessThan(330)

			// A markup over the text between two points ("Page 1" at 72, 842 - 720 on its baseline, 24 pt).
			const markup = await engine.client.call("dispatch", {
				command: "annotations.markup",
				args: { page: 0, author: AUTHOR, kind: "Highlight", from: [70, 110], to: [150, 118] }
			})
			const highlight = (await annotations(engine.client)).find(info => info.id === markup.created?.id)

			expect(highlight).toMatchObject({ type: "Highlight" })
			expect(highlight?.rect[1]).toBeLessThan(122)
			expect(highlight?.rect[3]).toBeGreaterThan(110)
			await expect(
				engine.client.call("dispatch", {
					command: "annotations.markup",
					args: { page: 0, author: AUTHOR, kind: "Underline", from: [400, 600], to: [420, 610] }
				})
			).rejects.toMatchObject({ failure: "badRequest" })

			const made = [
				{
					command: "annotations.shape",
					args: { page: 1, author: AUTHOR, kind: "Circle", rect: [100, 100, 200, 160], fill: [0, 1, 0] }
				},
				{ command: "annotations.line", args: { page: 1, author: AUTHOR, from: [100, 400], to: [300, 400], end: "OpenArrow" } },
				{ command: "annotations.stamp", args: { page: 1, author: AUTHOR, rect: [300, 500, 450, 550], name: "Approved" } },
				{ command: "annotations.image", args: { page: 1, author: AUTHOR, rect: [100, 600, 200, 650], image: png() } },
				{ command: "annotations.note", args: { page: 1, author: AUTHOR, at: [500, 100], text: "Look here" } }
			] as const

			for (const step of made) {
				const result = await engine.client.call("dispatch", step)

				expect(result.created?.page).toBe(1)
			}

			expect((await annotations(engine.client, 1)).map(info => info.type)).toEqual(["Circle", "Line", "Stamp", "Stamp", "Text"])

			// Saved (a full rewrite), read back by MuPDF and pdf.js.
			const begun = await engine.client.call("saveBegin", {
				inputBytes: source.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: false
			})

			if (begun.status !== "written") throw new Error("refused")

			const { bytes } = await upload(engine.client)

			await engine.client.call("saveEnd", { outcome: "saved", next: "continue" })

			const reopened = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()

			if (reopened === null) throw new Error("not a PDF")

			const types = (index: number): string[] =>
				pdfPage(reopened, index)
					.getAnnotations()
					.map(annotation => annotation.getType())

			expect(types(0)).toEqual(["FreeText", "Ink", "Highlight"])
			expect(types(1)).toEqual(["Circle", "Line", "Stamp", "Stamp", "Text"])
			reopened.destroy()

			const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
			const document = await task.promise
			const subtypes = (await (await document.getPage(2)).getAnnotations()) as { subtype: string; contentsObj?: { str: string } }[]

			expect(subtypes.map(entry => entry.subtype)).toEqual(expect.arrayContaining(["Circle", "Line", "Stamp", "Text"]))
			expect(subtypes.find(entry => entry.subtype === "Text")?.contentsObj?.str).toBe("Look here")
			await task.destroy()
		},
		TIMEOUT
	)

	it(
		"changes, comments on and deletes annotations, and refuses locked ones and malformed arguments",
		async () => {
			const engine = startEngine(lockedPdf())

			await engine.open()

			const [locked] = await annotations(engine.client)

			expect(locked).toMatchObject({ type: "Square", locked: true })
			await expect(
				engine.client.call("dispatch", { command: "annotations.move", args: { page: 0, id: locked?.id ?? 0, dx: 5, dy: 5 } })
			).rejects.toMatchObject({ failure: "notAllowed" })
			await expect(
				engine.client.call("dispatch", { command: "annotations.delete", args: { page: 0, id: locked?.id ?? 0 } })
			).rejects.toMatchObject({ failure: "notAllowed" })

			const shape = await engine.client.call("dispatch", {
				command: "annotations.shape",
				args: { page: 0, author: AUTHOR, kind: "Square", rect: [100, 100, 200, 200] }
			})
			const ref = { page: 0, id: shape.created?.id ?? -1 }

			await engine.client.call("dispatch", { command: "annotations.move", args: { ...ref, dx: 10, dy: 20 } })
			await engine.client.call("dispatch", { command: "annotations.resize", args: { ...ref, rect: [110, 120, 260, 300] } })
			await engine.client.call("dispatch", {
				command: "annotations.style",
				args: { ...ref, style: { color: [0, 0, 1], opacity: 0.5, width: 4 } }
			})
			await engine.client.call("dispatch", { command: "annotations.text", args: { ...ref, text: "Check this" } })

			const changed = (await annotations(engine.client)).find(info => info.id === ref.id)

			expect(changed).toMatchObject({ color: [0, 0, 1], opacity: 0.5, width: 4, text: "Check this" })
			expect(changed?.rect[0]).toBeCloseTo(110, 0)

			await engine.client.call("dispatch", { command: "annotations.reply", args: { ...ref, text: "Agreed", author: "Bo" } })
			await engine.client.call("dispatch", { command: "annotations.state", args: { ...ref, state: "Completed", author: "Bo" } })

			const threads = await engine.client.call("comments", {})
			const thread = threads.find(entry => entry.root.id === ref.id)

			expect(thread).toMatchObject({ state: "Completed", root: { text: "Check this" } })
			expect(thread?.replies.map(reply => [reply.author, reply.text])).toEqual([["Bo", "Agreed"]])
			// Replies and states are no annotations of their own on the page.
			expect((await annotations(engine.client)).map(info => info.id)).toEqual([locked?.id, ref.id])

			await engine.client.call("dispatch", { command: "annotations.delete", args: ref })
			expect(await engine.client.call("comments", {})).toEqual([])
			await engine.client.call("undo", {})
			expect((await engine.client.call("comments", {})).map(entry => entry.root.id)).toEqual([ref.id])

			for (const bad of [
				{ command: "annotations.move", args: { page: 0, id: ref.id, dx: "1", dy: 0 } },
				{ command: "annotations.shape", args: { page: 0, author: AUTHOR, kind: "Square", rect: [1, 2, 3] } },
				{ command: "annotations.style", args: { ...ref, style: { color: [2, 0, 0] } } },
				{ command: "annotations.markup", args: { page: 0, author: AUTHOR, kind: "Highlight" } },
				{ command: "annotations.image", args: { page: 0, author: AUTHOR, rect: [0, 0, 10, 10], image: new Uint8Array() } },
				{ command: "annotations.stamp", args: { page: 0, author: AUTHOR, rect: [0, 0, 10, 10], name: "Nope" } },
				{ command: "annotations.move", args: { page: 0, id: 999_999, dx: 1, dy: 1 } },
				{ command: "annotations.note", args: { page: 9, author: AUTHOR, at: [1, 1], text: "" } }
			]) {
				await expect(engine.client.call("dispatch", bad)).rejects.toMatchObject({ failure: "badRequest" })
			}

			const attachments = await engine.client.call("attachments", {})

			expect(attachments).toEqual([
				{ name: "notes.txt", size: expect.any(Number) as number, source: { kind: "document", key: "notes.txt" } }
			])

			const first = attachments[0]

			if (first === undefined) throw new Error("no attachment")

			expect(new TextDecoder().decode((await engine.client.call("attachment", { source: first.source })) ?? new Uint8Array())).toBe(
				"hi"
			)
		},
		TIMEOUT
	)

	it(
		"flattens every annotation into its page as one step",
		async () => {
			const engine = startEngine(makePdf({ pages: 1 }))

			await engine.open()
			await engine.client.call("dispatch", {
				command: "annotations.shape",
				args: { page: 0, author: AUTHOR, kind: "Square", rect: [100, 100, 200, 200] }
			})

			const flattened = await engine.client.call("dispatch", { command: "annotations.flatten", args: {} })

			expect(flattened.pages).toEqual([0])
			expect(flattened.state.changes).toContain("content")
			expect(await annotations(engine.client)).toEqual([])
			await engine.client.call("undo", {})
			expect(await annotations(engine.client)).toHaveLength(1)
		},
		TIMEOUT
	)
})
