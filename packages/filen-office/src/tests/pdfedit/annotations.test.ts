import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { classifyLink } from "@filen/shared/linkPolicy"
import { describe, expect, it } from "vitest"
import {
	boundsOfQuads,
	hexToRgb,
	richTextToPlain,
	rgbOf,
	rgbToHex,
	type PdfAnnotationRef,
	type PdfLinkInfo
} from "../../core/pdfedit/annotations"
import {
	addImageStamp,
	addInk,
	addInkStroke,
	addLine,
	addPresetStamp,
	addReply,
	addShape,
	addStickyNote,
	addTextBox,
	addTextMarkup,
	deleteAnnotation,
	flattenAnnotations,
	listAnnotationAttachments,
	listAnnotations,
	listDocumentAttachments,
	listLinks,
	moveAnnotation,
	PdfAnnotationError,
	readAnnotation,
	readAttachment,
	readCommentThreads,
	resizeAnnotation,
	setAnnotationStyle,
	setAnnotationText,
	setHiddenForEditing,
	setReviewState
} from "../../dom/pdfedit/annotations"
import { makePdf } from "./fixtures"

// The annotation engine against real MuPDF: every function, journaled undo/redo, and saves (full rewrite) read back by
// MuPDF and pdf.js.

const NOW = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
const LATER = new Date(Date.UTC(2026, 0, 3, 3, 4, 5))
const AUTHOR = "Ann Lee"

function open(bytes: Uint8Array = makePdf({ pages: 2 })): mupdf.PDFDocument {
	const document = mupdf.Document.openDocument(bytes, "application/pdf").asPDF()

	if (document === null) throw new Error("not a PDF")

	document.enableJournal()

	return document
}

// One journal operation, as the session wraps every command.
function run<T>(document: mupdf.PDFDocument, label: string, command: () => T): T {
	document.beginOperation(label)

	const result = command()

	document.endOperation()

	return result
}

function save(document: mupdf.PDFDocument): Uint8Array {
	return document.saveToBuffer("garbage=compact,compress").asUint8Array().slice()
}

// Every annotation pdf.js reads on the page, drawn or not.
async function pdfjsAnnotations(
	bytes: Uint8Array,
	page = 1
): Promise<{ subtype: string; contents: string; title: string; inReplyTo?: string }[]> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
	const document = await task.promise
	const annotations = (await (await document.getPage(page)).getAnnotations({ intent: "any" })) as {
		subtype: string
		contentsObj?: { str: string }
		titleObj?: { str: string }
		inReplyTo?: string
	}[]

	await task.destroy()

	return annotations.map(annotation => ({
		subtype: annotation.subtype,
		contents: annotation.contentsObj?.str ?? "",
		title: annotation.titleObj?.str ?? "",
		...(annotation.inReplyTo === undefined ? {} : { inReplyTo: annotation.inReplyTo })
	}))
}

// The text "Page 1" of makePdf's first page, as structured text quads.
function pageTextQuads(document: mupdf.PDFDocument): mupdf.Quad[] {
	const text = document.loadPage(0).toStructuredText("preserve-whitespace")
	const hits = text.search("Page 1", null)

	return hits[0] ?? []
}

function only<T>(items: readonly T[]): T {
	expect(items).toHaveLength(1)

	const [item] = items

	if (item === undefined) throw new Error("empty")

	return item
}

function png(): Uint8Array {
	const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 4], false)

	pixmap.clear(200)

	const bytes = pixmap.asPNG().slice()

	pixmap.destroy()

	return bytes
}

describe("core annotation helpers", () => {
	it("reduces rich text to plain text without markup", () => {
		expect(
			richTextToPlain(
				'<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p>One &amp; <b>two</b></p><p>three<br/>four &#x263A;</p></body>'
			)
		).toBe("One & two\nthree\nfour ☺")
		expect(richTextToPlain("<script>alert(1)</script>&lt;img&gt;")).toBe("alert(1)<img>")
		expect(richTextToPlain("broken <p")).toBe("broken ")
	})

	it("converts colours", () => {
		expect(rgbToHex([1, 0.5, 0])).toBe("FF8000")
		expect(hexToRgb("#ff8000")).toEqual([1, 128 / 255, 0])
		expect(hexToRgb("nope")).toBeNull()
		expect(rgbOf([0.5])).toEqual([0.5, 0.5, 0.5])
		expect(rgbOf([0, 0, 0, 1])).toEqual([0, 0, 0])
		expect(rgbOf([])).toBeNull()
	})

	it("bounds quads", () => {
		expect(boundsOfQuads([[1, 2, 5, 2, 1, 8, 5, 8]])).toEqual([1, 2, 5, 8])
		expect(boundsOfQuads([])).toBeNull()
	})
})

describe("creating annotations", () => {
	it("adds a text box with its style, author and dates, and undoes it", async () => {
		const document = open()
		const created = run(document, "Add text box", () =>
			addTextBox(document, {
				page: 0,
				author: AUTHOR,
				now: NOW,
				rect: [100, 100, 300, 160],
				text: "Hello\nworld",
				font: "TiRo",
				size: 14,
				color: [1, 0, 0],
				align: "center",
				opacity: 0.5
			})
		)

		expect(created.pages).toEqual([0])

		const info = readAnnotation(document, 0, created.ref.id)

		expect(info).toMatchObject({
			type: "FreeText",
			rect: [100, 100, 300, 160],
			color: [1, 0, 0],
			opacity: 0.5,
			author: AUTHOR,
			created: NOW.getTime(),
			modified: NOW.getTime(),
			text: "Hello\nworld",
			geometry: "rect",
			locked: false,
			replyTo: null
		})

		document.undo()
		expect(listAnnotations(document, 0)).toEqual([])
		document.redo()
		expect(listAnnotations(document, 0)).toHaveLength(1)

		const saved = save(document)

		expect(only(listAnnotations(open(saved), 0))).toMatchObject({ type: "FreeText", text: "Hello\nworld", author: AUTHOR })
		expect(await pdfjsAnnotations(saved)).toEqual([{ subtype: "FreeText", contents: "Hello\nworld", title: AUTHOR }])
	})

	it("adds ink, then one more stroke per operation", () => {
		const document = open()
		const { ref } = run(document, "Draw", () =>
			addInk(document, {
				page: 1,
				author: AUTHOR,
				now: NOW,
				strokes: [
					[
						[10, 10],
						[20, 20],
						[30, 10]
					]
				],
				color: [0, 0, 1],
				width: 3
			})
		)

		run(document, "Draw", () =>
			addInkStroke(
				document,
				ref,
				[
					[40, 40],
					[50, 50]
				],
				LATER
			)
		)

		document.undo()
		expect(only(document.loadPage(1).getAnnotations()).getInkList()).toHaveLength(1)
		document.redo()

		const page = open(save(document)).loadPage(1)
		const ink = only(page.getAnnotations())

		expect(ink.getInkList()).toEqual([
			[
				[10, 10],
				[20, 20],
				[30, 10]
			],
			[
				[40, 40],
				[50, 50]
			]
		])
		expect(ink.getBorderWidth()).toBe(3)
		expect(() => addInkStroke(document, { page: 1, id: 99_999 }, [[0, 0]], NOW)).toThrow(PdfAnnotationError)
	})

	it.each(["Highlight", "Underline", "StrikeOut", "Squiggly"] as const)("adds a %s over structured text quads", async kind => {
		const document = open()
		const quads = pageTextQuads(document)

		expect(quads.length).toBeGreaterThan(0)

		run(document, kind, () => addTextMarkup(document, { page: 0, author: AUTHOR, now: NOW, kind, quads, text: "note" }))

		const saved = save(document)
		const markup = only(open(saved).loadPage(0).getAnnotations())

		expect(markup.getType()).toBe(kind)
		expect(markup.getQuadPoints()).toHaveLength(quads.length)
		expect(await pdfjsAnnotations(saved)).toEqual([{ subtype: kind, contents: "note", title: AUTHOR }])
		expect(() => addTextMarkup(document, { page: 0, author: AUTHOR, now: NOW, kind, quads: [] })).toThrow(PdfAnnotationError)
	})

	it("adds shapes and lines with endings", async () => {
		const document = open()

		run(document, "Shape", () =>
			addShape(document, { page: 0, author: AUTHOR, now: NOW, kind: "Square", rect: [300, 300, 400, 380], fill: [1, 1, 0], width: 2 })
		)
		run(document, "Shape", () => addShape(document, { page: 0, author: AUTHOR, now: NOW, kind: "Circle", rect: [100, 300, 200, 380] }))
		run(document, "Line", () =>
			addLine(document, {
				page: 0,
				author: AUTHOR,
				now: NOW,
				from: [100, 500],
				to: [300, 520],
				end: "ClosedArrow",
				color: [0, 0.5, 0]
			})
		)

		const saved = save(document)
		const [square, circle, line] = open(saved).loadPage(0).getAnnotations()

		expect(square?.getInteriorColor()).toEqual([1, 1, 0])
		expect(square?.getBorderWidth()).toBe(2)
		expect(circle?.getType()).toBe("Circle")
		expect(line?.getLine()).toEqual([
			[100, 500],
			[300, 520]
		])
		expect(line?.getLineEndingStyles()).toEqual({ start: "None", end: "ClosedArrow" })
		expect((await pdfjsAnnotations(saved)).map(annotation => annotation.subtype)).toEqual(["Square", "Circle", "Line"])
	})

	it("adds image and preset stamps", async () => {
		const document = open()
		const image = run(document, "Stamp", () =>
			addImageStamp(mupdf, document, { page: 0, author: AUTHOR, now: NOW, rect: [50, 50, 130, 90], image: png() })
		)

		run(document, "Stamp", () =>
			addPresetStamp(document, { page: 0, author: AUTHOR, now: NOW, rect: [50, 200, 250, 260], name: "Approved" })
		)

		// Moving an image stamp keeps its picture (its appearance is not regenerated from the stamp name).
		run(document, "Move", () => moveAnnotation(document, image.ref, 10, 10, LATER))

		const saved = save(document)
		const [picture, approved] = open(saved).loadPage(0).getAnnotations()
		const appearance = picture?.getObject().get("AP").get("N").resolve()

		expect(picture?.getRect()).toEqual([60, 60, 140, 100])
		expect(appearance?.get("Resources").get("XObject").isDictionary()).toBe(true)
		expect(approved?.getIcon()).toBe("Approved")
		expect((await pdfjsAnnotations(saved)).map(annotation => annotation.subtype)).toEqual(["Stamp", "Stamp"])
		expect(() =>
			addImageStamp(mupdf, document, { page: 0, author: AUTHOR, now: NOW, rect: [0, 0, 1, 1], image: new Uint8Array([1, 2, 3]) })
		).toThrow()
	})

	it("refuses empty rects and missing pages", () => {
		const document = open()

		expect(() => addShape(document, { page: 0, author: AUTHOR, now: NOW, kind: "Square", rect: [10, 10, 10, 50] })).toThrow(
			PdfAnnotationError
		)
		expect(() => addShape(document, { page: 5, author: AUTHOR, now: NOW, kind: "Square", rect: [10, 10, 20, 50] })).toThrow(
			PdfAnnotationError
		)
	})
})

describe("changing annotations", () => {
	function withBox(): { document: mupdf.PDFDocument; ref: PdfAnnotationRef } {
		const document = open()
		const { ref } = run(document, "Add", () =>
			addShape(document, { page: 0, author: AUTHOR, now: NOW, kind: "Square", rect: [100, 100, 200, 150], width: 2 })
		)

		return { document, ref }
	}

	it("moves and resizes rect annotations", () => {
		const { document, ref } = withBox()

		run(document, "Move", () => moveAnnotation(document, ref, 10, -20, LATER))
		expect(readAnnotation(document, 0, ref.id)?.rect).toEqual([110, 80, 210, 130])
		expect(readAnnotation(document, 0, ref.id)?.modified).toBe(LATER.getTime())

		run(document, "Resize", () => resizeAnnotation(document, ref, [0, 0, 50, 40], LATER))
		expect(readAnnotation(document, 0, ref.id)?.rect).toEqual([0, 0, 50, 40])

		document.undo()
		document.undo()
		expect(readAnnotation(document, 0, ref.id)?.rect).toEqual([100, 100, 200, 150])
	})

	it("moves a sticky note with its popup and keeps its icon size on resize", () => {
		const document = open()
		const { ref } = run(document, "Note", () =>
			addStickyNote(document, { page: 0, author: AUTHOR, now: NOW, at: [300, 300], text: "x" })
		)
		const popupRect = (): number[] => {
			const rect = document.loadPage(0).getAnnotations()[0]?.getObject().get("Popup").get("Rect")

			return [0, 1, 2, 3].map(index => rect?.get(index).asNumber() ?? NaN)
		}
		const before = popupRect()

		run(document, "Move", () => moveAnnotation(document, ref, 10, 20, LATER))
		expect(readAnnotation(document, 0, ref.id)?.rect).toEqual([310, 320, 330, 340])
		// Page space grows downwards, the PDF's user space upwards.
		expect(popupRect()).toEqual(before.map((value, index) => value + (index % 2 === 0 ? 10 : -20)))

		run(document, "Resize", () => resizeAnnotation(document, ref, [0, 0, 100, 100], LATER))
		expect(readAnnotation(document, 0, ref.id)?.rect).toEqual([0, 0, 20, 20])
	})

	it("moves and resizes points annotations within their stroke margin", () => {
		const document = open()
		const { ref } = run(document, "Draw", () =>
			addInk(document, {
				page: 0,
				author: AUTHOR,
				now: NOW,
				strokes: [
					[
						[100, 100],
						[200, 200]
					]
				],
				width: 4
			})
		)
		const before = readAnnotation(document, 0, ref.id)?.rect

		run(document, "Move", () => moveAnnotation(document, ref, 5, 5, LATER))
		expect(only(document.loadPage(0).getAnnotations()).getInkList()).toEqual([
			[
				[105, 105],
				[205, 205]
			]
		])

		const moved = readAnnotation(document, 0, ref.id)?.rect

		expect(moved).toEqual(before?.map(value => value + 5))

		if (moved === undefined) throw new Error("gone")

		run(document, "Resize", () =>
			resizeAnnotation(document, ref, [moved[0], moved[1], moved[0] + (moved[2] - moved[0]) * 2, moved[3]], LATER)
		)

		const [[a, b] = []] = only(document.loadPage(0).getAnnotations()).getInkList()

		expect(a).toEqual([105, 105])
		// The new bounds' extra width, less the stroke's margin on both sides, goes to the points.
		expect(b?.[0]).toBeCloseTo(305 + 2 * (moved[2] - 205), 3)
		expect(b?.[1]).toBeCloseTo(205, 3)
	})

	it("refuses to move text markups and locked annotations", () => {
		const document = open()
		const { ref } = run(document, "Highlight", () =>
			addTextMarkup(document, { page: 0, author: AUTHOR, now: NOW, kind: "Highlight", quads: pageTextQuads(document) })
		)

		expect(() => moveAnnotation(document, ref, 1, 1, NOW)).toThrow(PdfAnnotationError)

		const { ref: box } = run(document, "Add", () =>
			addShape(document, { page: 0, author: AUTHOR, now: NOW, kind: "Square", rect: [1, 1, 20, 20] })
		)
		const annotation = document
			.loadPage(0)
			.getAnnotations()
			.find(item => item.getObject().asIndirect() === box.id)

		annotation?.setFlags(annotation.getFlags() | (1 << 7))
		expect(readAnnotation(document, 0, box.id)?.locked).toBe(true)
		expect(() => deleteAnnotation(document, box)).toThrow(PdfAnnotationError)
	})

	it("restyles and retexts", async () => {
		const document = open()
		const { ref } = run(document, "Add", () =>
			addTextBox(document, {
				page: 0,
				author: AUTHOR,
				now: NOW,
				rect: [100, 100, 300, 160],
				text: "a",
				font: "Helv",
				size: 12,
				color: [0, 0, 0],
				align: "left"
			})
		)

		run(document, "Style", () =>
			setAnnotationStyle(document, ref, { color: [0, 0, 1], size: 20, opacity: 0.25, align: "right" }, LATER)
		)
		run(document, "Text", () => setAnnotationText(document, ref, "changed", LATER))

		const saved = save(document)
		const box = only(open(saved).loadPage(0).getAnnotations())

		expect(box.getDefaultAppearance()).toEqual({ font: "Helv", size: 20, color: [0, 0, 1] })
		expect(box.getQuadding()).toBe(2)
		expect(box.getOpacity()).toBe(0.25)
		expect(only(await pdfjsAnnotations(saved)).contents).toBe("changed")

		const shape = run(document, "Add", () =>
			addShape(document, { page: 0, author: AUTHOR, now: NOW, kind: "Square", rect: [1, 1, 20, 20], fill: [1, 0, 0] })
		)

		run(document, "Style", () => setAnnotationStyle(document, shape.ref, { color: [0, 1, 0], fill: null, width: 5 }, LATER))
		expect(readAnnotation(document, 0, shape.ref.id)).toMatchObject({ color: [0, 1, 0], interiorColor: null, width: 5 })
	})

	it("deletes an annotation with its popup and replies", () => {
		const document = open()
		const note = run(document, "Note", () =>
			addStickyNote(document, { page: 0, author: AUTHOR, now: NOW, at: [300, 300], text: "root" })
		)

		run(document, "Reply", () => addReply(document, note.ref, { text: "reply", author: "Bo", now: LATER }))
		run(document, "State", () => setReviewState(document, note.ref, { state: "Accepted", author: "Bo", now: LATER }))
		// The note, its reply and its state (MuPDF lists no popups); the note's popup is in /Annots.
		expect(document.loadPage(0).getAnnotations()).toHaveLength(3)
		expect(document.loadPage(0).getObject().get("Annots").length).toBe(4)

		run(document, "Delete", () => deleteAnnotation(document, note.ref))
		expect(document.loadPage(0).getObject().get("Annots").length).toBe(0)
		document.undo()
		expect(document.loadPage(0).getObject().get("Annots").length).toBe(4)
	})

	it("hides an annotation for an overlay editor without journaling", () => {
		const document = open()
		const { ref } = run(document, "Add", () =>
			addShape(document, { page: 0, author: AUTHOR, now: NOW, kind: "Square", rect: [1, 1, 20, 20] })
		)
		const steps = document.getJournal().steps.length

		setHiddenForEditing(document, ref, true)
		expect(document.loadPage(0).getAnnotations()[0]?.getHiddenForEditing()).toBe(true)
		expect(document.getJournal().steps.length).toBe(steps)
	})
})

describe("comments", () => {
	it("reads threads with replies and the latest review state, and writes them for pdf.js", async () => {
		const document = open()
		const note = run(document, "Note", () =>
			addStickyNote(document, { page: 0, author: AUTHOR, now: NOW, at: [300, 300], text: "Check this" })
		)
		const markup = run(document, "Highlight", () =>
			addTextMarkup(document, { page: 0, author: AUTHOR, now: NOW, kind: "Highlight", quads: pageTextQuads(document) })
		)

		run(document, "Reply", () => addReply(document, note.ref, { text: "Done", author: "Bo", now: LATER }))
		run(document, "Reply", () => addReply(document, markup.ref, { text: "Why?", author: "Bo", now: NOW }))
		run(document, "State", () => setReviewState(document, note.ref, { state: "Accepted", author: "Bo", now: NOW }))
		run(document, "State", () => setReviewState(document, note.ref, { state: "Completed", author: "Bo", now: LATER }))

		const threads = readCommentThreads(document)

		expect(threads).toHaveLength(2)
		expect(threads[0]).toMatchObject({
			page: 0,
			root: { id: note.ref.id, type: "Text", author: AUTHOR, text: "Check this", created: NOW.getTime() },
			replies: [{ author: "Bo", text: "Done", created: LATER.getTime() }],
			state: "Completed"
		})
		// A markup without a note is a thread once replied to.
		expect(threads[1]).toMatchObject({
			root: { id: markup.ref.id, type: "Highlight", text: "" },
			replies: [{ text: "Why?" }],
			state: "None"
		})
		// One state annotation per author: the second state updated the first.
		expect(
			document
				.loadPage(0)
				.getAnnotations()
				.filter(annotation => !annotation.getObject().get("StateModel").isNull())
		).toHaveLength(1)
		// Replies and states are not drawn: the on-page list leaves them out.
		expect(listAnnotations(document, 0).map(info => info.type)).toEqual(["Text", "Highlight"])

		const saved = save(document)

		expect(
			readCommentThreads(open(saved)).map(thread => [thread.root.text, thread.replies.map(reply => reply.text), thread.state])
		).toEqual([
			["Check this", ["Done"], "Completed"],
			["", ["Why?"], "None"]
		])

		const replies = (await pdfjsAnnotations(saved)).filter(annotation => annotation.inReplyTo !== undefined)

		expect(replies.map(reply => reply.contents).sort()).toEqual(["Completed", "Done", "Why?"])
	})

	it("reads rich text notes as plain text and skips annotations without comments", () => {
		const document = open()
		const box = run(document, "Add", () =>
			addShape(document, { page: 0, author: AUTHOR, now: NOW, kind: "Square", rect: [1, 1, 20, 20] })
		)

		expect(readCommentThreads(document)).toEqual([])

		const annotation = document.loadPage(0).getAnnotations()[0]

		annotation?.setRichContents("", "<body><p>Rich <b>bold</b></p><p>&lt;script&gt;</p></body>")
		expect(only(readCommentThreads(document)).root.text).toBe("Rich bold\n<script>")
		expect(readAnnotation(document, 0, box.ref.id)?.text).toBe("Rich bold\n<script>")

		run(document, "Edit", () => setAnnotationText(document, box.ref, "plain", LATER))
		expect(document.loadPage(0).getAnnotations()[0]?.hasRichContents()).toBe(true)
		expect(document.loadPage(0).getAnnotations()[0]?.getObject().get("RC").isNull()).toBe(true)
	})

	it("refuses comments on links", () => {
		const document = open()

		document.loadPage(0).createLink([10, 10, 50, 50], "https://example.com")

		const link = document.loadPage(0).getObject().get("Annots").get(0)

		expect(() => addReply(document, { page: 0, id: link.asIndirect() }, { text: "x", author: AUTHOR, now: NOW })).toThrow(
			PdfAnnotationError
		)
	})
})

describe("flattening, links and attachments", () => {
	it("flattens annotations into page content and keeps links", async () => {
		const document = open()

		run(document, "Add", () => addShape(document, { page: 0, author: AUTHOR, now: NOW, kind: "Square", rect: [100, 100, 200, 150] }))
		document.loadPage(0).createLink([10, 10, 50, 50], "https://example.com")
		expect(run(document, "Flatten", () => flattenAnnotations(document))).toEqual([0, 1])

		const saved = save(document)

		expect(listAnnotations(open(saved), 0)).toEqual([])
		expect((await pdfjsAnnotations(saved)).map(annotation => annotation.subtype)).toEqual(["Link"])
	})

	it("lists links with their targets without following them", () => {
		const document = open()
		const page = document.loadPage(0)

		page.createLink([10, 10, 50, 50], "https://example.com/a")
		page.createLink([10, 60, 50, 90], "#page=2")
		page.createLink([10, 100, 50, 130], "mailto:ann@example.com")

		expect(listLinks(open(save(document)), 0)).toEqual([
			{ page: 0, rect: [10, 10, 50, 50], target: { kind: "uri", uri: "https://example.com/a" } },
			{ page: 0, rect: [10, 60, 50, 90], target: { kind: "page", page: 1 } },
			{ page: 0, rect: [10, 100, 50, 130], target: { kind: "uri", uri: "mailto:ann@example.com" } }
		])
	})

	// Link annotations as a hostile file writes them (MuPDF's createLink refuses most of these URIs).
	function withLinkActions(actions: readonly ((document: mupdf.PDFDocument) => Record<string, unknown>)[]): PdfLinkInfo[] {
		const document = open()

		run(document, "Links", () => {
			const annots = document.newArray()

			actions.forEach((action, index) => {
				annots.push(
					document.addObject({
						Type: "Annot",
						Subtype: "Link",
						Rect: [10, 10 + index * 40, 50, 40 + index * 40],
						A: action(document)
					})
				)
			})
			document.loadPage(0).getObject().put("Annots", annots)
		})

		return listLinks(open(save(document)), 0)
	}

	it("never returns a refused URI as navigable", () => {
		const hostile = [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			" javascript:alert(1)",
			"java\tscript:alert(1)",
			"java\nscript:alert(1)",
			"\u0001javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"DATA:text/html;base64,PHNjcmlwdD4=",
			"vbscript:msgbox(1)",
			"file:///etc/passwd",
			"FILE:///C:/Windows/calc.exe",
			"blob:https://example.com/0f0e",
			"custom-app://open?x=1",
			"intent://scan#Intent;scheme=zxing;end",
			"//evil.example.com/x",
			"https://"
		]
		const links = withLinkActions(hostile.map(uri => (document: mupdf.PDFDocument) => ({ S: "URI", URI: document.newString(uri) })))

		expect(links).toHaveLength(hostile.length)

		for (const link of links) expect(link.target.kind).not.toBe("uri")
	})

	it("returns an allowed URI as the link policy normalised it", () => {
		const raw = "HTTPS://Example.com/a?b=1"
		const verdict = classifyLink(raw)
		const [link] = withLinkActions([document => ({ S: "URI", URI: document.newString(raw) })])

		expect(verdict.kind).toBe("external")
		expect(link?.target).toEqual({ kind: "uri", uri: verdict.kind === "external" ? verdict.url : "" })
	})

	it("never returns Launch, GoToR or JavaScript actions as navigable", () => {
		const links = withLinkActions([
			document => ({ S: "Launch", F: document.newString("calc.exe") }),
			document => ({ S: "GoToR", F: document.newString("other.pdf"), D: [0, "Fit"] }),
			document => ({ S: "JavaScript", JS: document.newString("app.alert(1)") }),
			document => ({ S: "Launch", Win: { F: document.newString("cmd.exe") } })
		])

		// MuPDF lists only the actions it maps to a URI (GoToR and Launch of a file as file:), and none is navigable.
		expect(links.length).toBeGreaterThan(0)
		expect(links.filter(link => link.target.kind !== "none")).toEqual([])
	})

	it("lists attachments and hands out their bytes", () => {
		const document = open()
		const contents = new TextEncoder().encode("hello attachment")
		const spec = document.addEmbeddedFile("report.txt", "text/plain", contents, NOW, NOW)

		document.insertEmbeddedFile("report.txt", spec)

		const page = document.loadPage(1)
		const annotation = page.createAnnotation("FileAttachment")

		annotation.setRect([10, 10, 30, 30])
		annotation.setFileSpec(document.addEmbeddedFile("inner.bin", "application/x-msdownload", new Uint8Array([1, 2, 3]), NOW, NOW))
		annotation.update()

		const reopened = open(save(document))
		const documentFiles = listDocumentAttachments(reopened)
		const pageFiles = listAnnotationAttachments(reopened, 1)

		expect(documentFiles).toEqual([{ name: "report.txt", size: contents.length, source: { kind: "document", key: "report.txt" } }])
		expect(pageFiles).toMatchObject([{ name: "inner.bin", size: 3, source: { kind: "annotation" } }])
		expect(readAttachment(reopened, only(documentFiles).source)).toEqual(contents)
		expect(readAttachment(reopened, only(pageFiles).source)).toEqual(new Uint8Array([1, 2, 3]))
		expect(readAttachment(reopened, { kind: "document", key: "missing" })).toBeNull()
	})
})
