import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit"
import type { PdfEngineClient } from "../../dom/pdfedit/client"
import { makeFormPdf, makePdf } from "./fixtures"
import { startEngine, stopEngines, upload } from "./harness"
import { budget } from "../timing"

// A save writes the document in memory: the object numbers the page holds (widget and annotation ids) stay valid
// across it, and the history logs the annotations its steps work on by name (stepKeys.ts), so steps made after a save
// or an undo run again on a rebuild of the file the history starts at.

afterEach(stopEngines)

const TIMEOUT = budget(30_000)

async function nameWidget(client: PdfEngineClient) {
	const pages = await client.call("widgets", { pages: [0] })
	const found = pages.flatMap(page => page.widgets).find(widget => widget.field === "name")

	if (found === undefined) throw new Error("no name field")

	return found
}

async function ofType(client: PdfEngineClient, type: string) {
	const read = await client.call("annotations", { pages: [0] })

	return (read[0]?.annotations ?? []).filter(annotation => annotation.type === type)
}

const squares = (client: PdfEngineClient) => ofType(client, "Square")

// One page with a square that has no /NM, as many files' annotations have none.
function unnamedSquarePdf(): Uint8Array {
	const document = mupdf.Document.openDocument(makePdf({ pages: 1 }), "application/pdf").asPDF()

	if (document === null) throw new Error("not a PDF")

	const page = document.loadPage(0)

	if (!(page instanceof mupdf.PDFPage)) throw new Error("not a PDF page")

	const square = page.createAnnotation("Square")

	square.setRect([50, 50, 100, 100])
	square.update()

	const bytes = document.saveToBuffer("compress").asUint8Array().slice()

	document.destroy()

	return bytes
}

// The /NM of every annotation on the first page of a file.
function names(bytes: Uint8Array): (string | null)[] {
	const document = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()
	const annots = document?.findPage(0).get("Annots")
	const out: (string | null)[] = []

	for (let at = 0; annots?.isArray() === true && at < annots.length; at++) {
		const name = annots.get(at).get("NM")

		out.push(name.isString() ? name.asString() : null)
	}

	document?.destroy()

	return out
}

async function save(client: PdfEngineClient, inputBytes: number): Promise<Uint8Array> {
	const begun = await client.call("saveBegin", { inputBytes, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })

	if (begun.status !== "written") throw new Error("refused")

	const { uploaded, bytes } = await upload(client)

	expect(uploaded).toBe(true)
	expect((await client.call("saveEnd", { outcome: "saved", next: "continue" })).history).toBe("kept")

	return bytes
}

describe("the history across a save", () => {
	it(
		"keeps ids across a rewrite and replays steps made after it (an annotation and a widget)",
		async () => {
			// An unused object before the form: a compacting rewrite would renumber every object after it.
			const source = makeFormPdf({ orphan: true })
			const engine = startEngine(source)

			await engine.open()

			const shape = await engine.client.call("dispatch", {
				command: "annotations.shape",
				args: { page: 0, author: "Ann", kind: "Square", rect: [300, 300, 400, 400] }
			})
			const square = shape.created?.id ?? -1
			const widget = (await nameWidget(engine.client)).id

			await save(engine.client, source.length)

			// What the page holds still names the same objects.
			expect((await nameWidget(engine.client)).id).toBe(widget)
			expect((await squares(engine.client)).map(annotation => annotation.id)).toEqual([square])

			await engine.client.call("dispatch", {
				command: "forms.setField",
				args: { page: 0, widget, value: { kind: "text", text: "Hello" } }
			})
			await engine.client.call("dispatch", { command: "annotations.move", args: { page: 0, id: square, dx: 10, dy: 20 } })

			// Back to the file as opened in one request (the journal takes back the steps after the save, one rebuild the
			// one before), then every step again.
			expect((await engine.client.call("undo", { steps: 3 })).state).toMatchObject({ canUndo: false, canRedo: true })

			expect(await squares(engine.client)).toEqual([])
			expect((await nameWidget(engine.client)).value).toBe("")

			for (let step = 0; step < 3; step++) await engine.client.call("redo", {})

			expect((await nameWidget(engine.client)).value).toBe("Hello")
			expect((await squares(engine.client)).map(annotation => annotation.rect)).toEqual([[310, 320, 410, 420]])
			expect((await engine.client.call("state", {})).canRedo).toBe(false)
		},
		TIMEOUT
	)

	it(
		"replays steps on annotations made after an undo or a save, and on one the file had without a name",
		async () => {
			const source = unnamedSquarePdf()
			const engine = startEngine(source)
			const circle = { page: 0, author: "Ann", kind: "Circle", rect: [200, 200, 260, 260] } as const
			const move = (id: number, dx: number) =>
				engine.client.call("dispatch", { command: "annotations.move", args: { page: 0, id, dx, dy: 0 } })

			await engine.open()

			// The number of a circle made and undone is never given again: the next circle gets another.
			await engine.client.call("dispatch", { command: "annotations.shape", args: circle })
			await engine.client.call("undo", {})

			const first = (await engine.client.call("dispatch", { command: "annotations.shape", args: circle })).created?.id ?? -1

			await move(first, 10)

			const written = await save(engine.client, source.length)
			const square = (await squares(engine.client))[0]?.id ?? -1

			// Made in its step, the circle carries its name into the file; the square the file had is not renamed.
			expect(names(written)).toEqual([null, expect.stringMatching(/^filen-/)])

			await move(square, 5)

			const second = (await engine.client.call("dispatch", { command: "annotations.shape", args: circle })).created?.id ?? -1

			await move(second, 30)

			for (let step = 0; step < 5; step++) await engine.client.call("undo", {})

			expect(await ofType(engine.client, "Circle")).toEqual([])
			expect((await squares(engine.client)).map(annotation => annotation.rect)).toEqual([[50, 50, 100, 100]])

			for (let step = 0; step < 5; step++) await engine.client.call("redo", {})

			expect((await squares(engine.client)).map(annotation => annotation.rect)).toEqual([[55, 50, 105, 100]])
			expect((await ofType(engine.client, "Circle")).map(annotation => annotation.rect)).toEqual([
				[210, 200, 270, 260],
				[230, 200, 290, 260]
			])

			// Several steps back at once, through the journal.
			const back = await engine.client.call("undo", { steps: 4 })

			expect(back.state).toMatchObject({ canUndo: true, undoLabel: "annotations.shape" })
			expect((await ofType(engine.client, "Circle")).map(annotation => annotation.rect)).toEqual([[200, 200, 260, 260]])
			expect((await squares(engine.client)).map(annotation => annotation.rect)).toEqual([[50, 50, 100, 100]])
			await expect(engine.client.call("undo", { steps: 0 })).rejects.toMatchObject({ failure: "badRequest" })
		},
		TIMEOUT
	)
})
