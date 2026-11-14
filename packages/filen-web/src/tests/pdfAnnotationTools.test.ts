import { describe, expect, it, vi } from "vitest"
import type { PdfAnnotationInfo } from "@filen/office/core/pdfedit/annotations"
import type { PdfCommandResult, PdfEditState } from "@filen/office/core/pdfedit"
import { PageViewport, type PdfEditSessionModel, type PdfEditSnapshot } from "@filen/office/react/pdfedit"
import { fakeToolContext } from "@/tests/support/pdfToolContext"

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { pageSpace, pageLayerStyle, textLines, viewBox, viewerAnnotationInfos } = await import("@/features/pdf/annotations/pageSpace.logic")
const { attachmentFileName, markupKindOf, placementToolKey, shapeKindOf, stampVariantOf } =
	await import("@/features/pdf/annotations/annotationTools.logic")
const { PdfAnnotationStore, annotationStoreOf } = await import("@/features/pdf/annotations/annotationStore")
const { selectionKey, placingKey } = await import("@/features/pdf/annotations/annotationKeys")
const { pdfSurfaceKey } = await import("@/features/pdf/tools/toolKeys.logic")
const { PDF_TOOLS } = await import("@/features/pdf/tools")
const { toolInEffect, toolVariant } = await import("@/features/pdf/tools/registry")
const { flattenedFirst } = await import("@/features/pdf/session/toolSession")

// The annotation tools' plain parts: page space over either engine's viewport (with the page's own and the view's
// rotation), the viewer's annotations and text as the tools read them, attachment names, the tool keys, and the store
// that keeps the editor's annotations current.

const close = (actual: readonly number[], expected: readonly number[]): void => {
	expect(actual).toHaveLength(expected.length)
	actual.forEach((value, index) => {
		expect(value).toBeCloseTo(expected[index] ?? NaN, 6)
	})
}

describe("page space", () => {
	it("maps the editor's viewport (page box from 0, y down) with the view's rotation", () => {
		const viewport = new PageViewport({ viewBox: [0, 0, 600, 800], scale: 2, rotation: 0 })
		const space = pageSpace(viewport, 0)

		expect(space.box).toEqual([0, 0, 600, 800])
		expect(space.scale).toBe(2)
		close(space.toPage(200, 100), [100, 50])
		close(space.toView(100, 50), [200, 100])

		const turned = pageSpace(new PageViewport({ viewBox: [0, 0, 600, 800], scale: 1, rotation: 90 }), 0)

		expect(turned.rotation).toBe(90)
		// The page's top left is the view's top right once turned clockwise.
		close(turned.toView(0, 0), [800, 0])
		close(turned.toPage(800, 0), [0, 0])
		expect(pageLayerStyle(turned)).toMatchObject({
			width: "600px",
			height: "800px",
			left: "100px",
			top: "-100px",
			transform: "rotate(90deg)"
		})
	})

	it("maps pdf.js's viewport of a rotated, cropped page to the same page space MuPDF uses", () => {
		// CropBox [50 60 500 700] with /Rotate 90: MuPDF's page is 640 × 450, its top left the box's bottom left.
		const viewport = new PageViewport({ viewBox: [50, 60, 500, 700], scale: 1.5, rotation: 90 })
		const space = pageSpace(viewport, 90)

		expect(space.rotation).toBe(0)
		close(space.box, [0, 0, 640, 450])
		close(space.fromUser(50, 60), [0, 0])
		close(space.fromUser(500, 700), [640, 450])
		close(space.toPage(0, 0), [0, 0])
		expect(viewBox(space, [0, 0, 64, 45])).toEqual({ left: 0, top: 0, width: 96, height: 67.5 })
	})

	it("reads pdf.js's annotations as the editor would list them, by object number", () => {
		const space = pageSpace(new PageViewport({ viewBox: [0, 0, 600, 800], scale: 1, rotation: 0 }), 0)
		const infos = viewerAnnotationInfos(
			[
				{
					subtype: "Square",
					id: "12R",
					rect: [100, 600, 200, 700],
					annotationFlags: 0,
					color: new Uint8ClampedArray([255, 0, 0]),
					borderStyle: { width: 2 },
					titleObj: { str: "Ann" },
					contentsObj: { str: "Look" }
				},
				{ subtype: "FreeText", id: "13R", rect: [0, 0, 10, 10], annotationFlags: 128 },
				{ subtype: "Link", id: "14R", rect: [0, 0, 10, 10] },
				{ subtype: "Text", id: "15R", rect: [0, 0, 10, 10], inReplyTo: "12R" },
				{ subtype: "Ink", id: "pdfjs_internal_id_1", rect: [0, 0, 10, 10] },
				{ subtype: "Circle", id: "16R", rect: [0, 0, "x", 10] }
			],
			0,
			space
		)

		expect(infos).toEqual([
			expect.objectContaining({
				id: 12,
				type: "Square",
				rect: [100, 100, 200, 200],
				color: [1, 0, 0],
				width: 2,
				author: "Ann",
				text: "Look",
				locked: false,
				geometry: "rect"
			}),
			expect.objectContaining({ id: 13, type: "FreeText", locked: true })
		])
	})

	it("lays out the shown text's lines for a markup draft, top to bottom", () => {
		const space = pageSpace(new PageViewport({ viewBox: [0, 0, 600, 800], scale: 1, rotation: 0 }), 0)
		const lines = textLines(
			[
				{ str: "second", transform: [10, 0, 0, 10, 72, 600], width: 60 },
				{ str: "first", transform: [10, 0, 0, 10, 72, 700], width: 50 },
				{ str: "  ", transform: [10, 0, 0, 10, 72, 650], width: 5 },
				{ str: "up", transform: [0, 10, -10, 0, 300, 300], width: 20 }
			],
			space
		)

		expect(lines).toHaveLength(2)
		close(lines[0]?.rect ?? [], [72, 92, 122, 102])
		close(lines[0]?.edges ?? [], [72, 82, 92, 102, 112, 122])
		expect(lines[1]?.rect[1]).toBeGreaterThan(190)
	})
})

describe("the annotation tools' choices", () => {
	it("reads variants, falling back to each tool's first", () => {
		expect(markupKindOf("Squiggly")).toBe("Squiggly")
		expect(markupKindOf(null)).toBe("Highlight")
		expect(shapeKindOf("Arrow")).toBe("Line")
		expect(shapeKindOf("nope")).toBe("Square")
		expect(stampVariantOf("Approved")).toBe("Approved")
		expect(stampVariantOf("imageFilen")).toBe("imageFilen")
		expect(stampVariantOf("javascript")).toBe("image")
		expect(placementToolKey("shape", "Circle")).toBe("previewPdfAnnotToolEllipse")
		expect(placementToolKey("stamp", "Draft")).toBe("previewPdfAnnotToolStamp")

		const markup = PDF_TOOLS.find(tool => tool.id === "annotations.markup")

		expect(markup === undefined ? null : toolVariant(markup, "StrikeOut")?.id).toBe("StrikeOut")
		expect(toolInEffect(PDF_TOOLS, null)?.id).toBe("annotations.select")
		expect(toolInEffect(PDF_TOOLS, "annotations.draw")?.id).toBe("annotations.draw")
	})

	it("names an attachment's download without directories or control characters", () => {
		expect(attachmentFileName("report.pdf")).toBe("report.pdf")
		expect(attachmentFileName("../../etc/passwd")).toBe("passwd")
		expect(attachmentFileName("C:\\Windows\\evil.exe")).toBe("evil.exe")
		expect(attachmentFileName("a\u0000b\u001fc\u007f.txt")).toBe("abc.txt")
		expect(attachmentFileName("dir/")).toBe("attachment")
		expect(attachmentFileName("..")).toBe("attachment")
		expect(attachmentFileName("")).toBe("attachment")
	})
})

describe("tool keys", () => {
	const key = (init: Partial<KeyboardEvent> & { key: string; code: string }) =>
		({
			metaKey: false,
			ctrlKey: false,
			altKey: false,
			shiftKey: false,
			getModifierState: () => false,
			...init
		}) as unknown as KeyboardEvent

	it("reads tool letters, the editor's Escape and Delete, Enter, the arrows and Space", () => {
		expect(pdfSurfaceKey(key({ key: "t", code: "KeyT" }), PDF_TOOLS, {}, false)).toMatchObject({
			kind: "tool",
			tool: { id: "annotations.textBox" }
		})
		expect(pdfSurfaceKey(key({ key: "v", code: "KeyV" }), PDF_TOOLS, {}, false)).toMatchObject({ tool: { id: "annotations.select" } })
		// A rebound letter.
		expect(pdfSurfaceKey(key({ key: "x", code: "KeyX" }), PDF_TOOLS, { "annotations.draw": "x" }, false)).toMatchObject({
			tool: { id: "annotations.draw" }
		})
		expect(pdfSurfaceKey(key({ key: "d", code: "KeyD" }), PDF_TOOLS, { "annotations.draw": "x" }, false)).toBeNull()
		expect(pdfSurfaceKey(key({ key: "Escape", code: "Escape" }), PDF_TOOLS, {}, false)).toEqual({ kind: "key", key: "Escape" })
		expect(pdfSurfaceKey(key({ key: "Backspace", code: "Backspace" }), PDF_TOOLS, {}, false)).toEqual({ kind: "key", key: "Delete" })
		expect(pdfSurfaceKey(key({ key: "ArrowLeft", code: "ArrowLeft" }), PDF_TOOLS, {}, false)).toEqual({ kind: "key", key: "ArrowLeft" })
		expect(pdfSurfaceKey(key({ key: " ", code: "Space" }), PDF_TOOLS, {}, false)).toEqual({ kind: "key", key: "Space" })
		expect(pdfSurfaceKey(key({ key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true }), PDF_TOOLS, {}, false)).toBeNull()
		// The viewer's letters are no tool's.
		expect(pdfSurfaceKey(key({ key: "n", code: "KeyN" }), PDF_TOOLS, {}, false)).toBeNull()
	})

	it("takes the flatten step before the save when chosen", async () => {
		const order: string[] = []
		const session = {
			dispatch: (command: string) => {
				order.push(command)

				return Promise.resolve({})
			}
		} as unknown as PdfEditSessionModel

		await flattenedFirst(session, false, () => Promise.resolve(order.push("save")))
		await flattenedFirst(session, true, () => Promise.resolve(order.push("save")))
		expect(order).toEqual(["save", "annotations.flatten", "save"])
	})
})

// --- The store and the selection's keys, over a session whose engine answers from a page map ---

const INFO: PdfAnnotationInfo = {
	page: 0,
	id: 7,
	type: "Square",
	rect: [10, 10, 50, 50],
	color: [1, 0, 0],
	interiorColor: null,
	opacity: 1,
	width: 1,
	author: "Ann",
	created: null,
	modified: null,
	text: "",
	replyTo: null,
	geometry: "rect",
	locked: false
}

function fakeSession(pages: Map<number, PdfAnnotationInfo[]>, calls: string[]) {
	const listeners = new Set<() => void>()
	let snapshot = { document: {}, touched: [] as number[], state: { revision: 1 } as PdfEditState } as unknown as PdfEditSnapshot

	const session = {
		engine: {
			call: (op: string, args: { pages?: number[] }) => {
				calls.push(`${op}:${(args.pages ?? []).join(",")}`)

				return Promise.resolve(
					op === "annotations"
						? (args.pages ?? []).map(page => ({ page, annotations: pages.get(page) ?? [] }))
						: op === "comments"
							? []
							: null
				)
			}
		},
		subscribe: (listener: () => void) => {
			listeners.add(listener)

			return () => listeners.delete(listener)
		},
		getSnapshot: () => snapshot,
		// A change that touched `touched`.
		change(touched: number[]) {
			snapshot = { ...snapshot, document: {}, touched } as unknown as PdfEditSnapshot

			for (const listener of listeners) listener()
		}
	}

	return session
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe("the annotation store", () => {
	it("reads the pages asked for once, and again only those a change touched", async () => {
		const calls: string[] = []
		const pages = new Map([[0, [INFO]]])
		const session = fakeSession(pages, calls)
		const store = new PdfAnnotationStore()

		store.bind(session as unknown as PdfEditSessionModel)
		expect(store.annotations(0)).toBeNull()
		expect(store.annotations(1)).toBeNull()
		await flush()
		expect(calls).toEqual(["annotations:0,1"])
		expect(store.annotations(0)).toEqual([INFO])

		store.select(INFO)
		pages.set(0, [{ ...INFO, rect: [20, 20, 60, 60] }])
		session.change([0])
		expect(store.annotations(1)).toEqual([])
		expect(store.annotations(0)).toBeNull()
		await flush()
		expect(calls).toEqual(["annotations:0,1", "annotations:0"])
		// The selection follows its annotation.
		expect(store.getState().selected?.rect).toEqual([20, 20, 60, 60])

		pages.set(0, [])
		session.change([0])
		store.annotations(0)
		await flush()
		expect(store.getState().selected).toBeNull()
	})

	it("selects what a command made once its page is read again", async () => {
		const pages = new Map<number, PdfAnnotationInfo[]>([[0, []]])
		const session = fakeSession(pages, [])
		const store = new PdfAnnotationStore()

		store.bind(session as unknown as PdfEditSessionModel)
		store.annotations(0)
		await flush()
		pages.set(0, [INFO])
		session.change([0])
		store.selectRef({ page: 0, id: 7 })
		await flush()
		expect(store.getState().selected?.id).toBe(7)
	})

	it("joins an ink stroke to the drawing only while nothing else changed", () => {
		const store = new PdfAnnotationStore()

		store.setInk({ page: 1, id: 9, revision: 4 })
		expect(store.inkTarget(1, 4)).toBe(9)
		expect(store.inkTarget(1, 5)).toBeNull()
		expect(store.inkTarget(0, 4)).toBeNull()
	})

	it("moves, resizes and deletes the selection from the keyboard, and refuses a locked one", () => {
		const changes: unknown[] = []
		const swap = {} as never
		const store = annotationStoreOf(swap)
		const context = fakeToolContext({
			edit: (change: (session: PdfEditSessionModel) => Promise<unknown>) => {
				void change({
					dispatch: (command: string, args: unknown) => {
						changes.push([command, args])

						return Promise.resolve({} as PdfCommandResult)
					}
				} as unknown as PdfEditSessionModel)
			},
			swap
		})
		const press = (name: "ArrowRight" | "ArrowDown" | "Delete" | "Escape", extra: { shift?: boolean; alt?: boolean } = {}) =>
			selectionKey({ kind: "down", key: name, shift: extra.shift ?? false, alt: extra.alt ?? false, page: 0 }, context)

		expect(press("ArrowRight")).toBe(false)
		store.select(INFO)
		expect(press("ArrowRight", { shift: true })).toBe(true)
		expect(press("ArrowDown", { alt: true })).toBe(true)
		expect(press("Delete")).toBe(true)
		expect(changes).toEqual([
			["annotations.move", { page: 0, id: 7, dx: 10, dy: 0 }],
			["annotations.resize", { page: 0, id: 7, rect: [20, 10, 60, 51] }],
			["annotations.delete", { page: 0, id: 7 }]
		])
		expect(store.getState().selected).toBeNull()

		store.select({ ...INFO, locked: true })
		changes.length = 0
		press("Delete")
		press("ArrowRight")
		expect(changes).toEqual([])
		expect(press("Escape")).toBe(true)
		expect(store.getState().selected).toBeNull()

		// Space is a temporary hand only while a tool is active.
		expect(placingKey({ kind: "down", key: "Space", shift: false, alt: false, page: 0 }, context)).toBe(false)
		expect(
			placingKey({ kind: "down", key: "Space", shift: false, alt: false, page: 0 }, { ...context, activeTool: "annotations.draw" })
		).toBe(true)
		expect(store.getState().hand).toBe(true)
		placingKey({ kind: "up", key: "Space", shift: false, alt: false, page: 0 }, { ...context, activeTool: "annotations.draw" })
		expect(store.getState().hand).toBe(false)
		// Escape with nothing placing goes back to selection.
		expect(placingKey({ kind: "down", key: "Escape", shift: false, alt: false, page: 0 }, context)).toBe(true)
		expect(context.finish).toHaveBeenCalled()
	})
})
