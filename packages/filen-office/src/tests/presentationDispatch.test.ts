import { describe, expect, it } from "vitest"
import { APPLY_FAMILIES, applyOp, opTouches, type ApplyContext } from "../core/presentation/edit/apply"
import { DECK_OP_FAMILIES, type DeckOpFamily, type OpOf } from "../core/presentation/edit/ops"
import { PresentationError, slideRef, type ShapeNode, type ShapeRef } from "../core/presentation/model"
import { emitFamilyOf, emitPptx, PPTX_EMIT_FAMILIES } from "../core/pptx/write/emit"
import type { PartsApi, PptxEmitContext } from "../core/pptx/write/types"
import { emitOdp, ODP_EMIT_FAMILIES, type OdpEmitContext } from "../core/odp/write/emit"
import {
	smartArtColors,
	smartArtLayout,
	smartArtStyle,
	SMARTART_COLORS,
	SMARTART_LAYOUTS,
	SMARTART_STYLES
} from "../core/smartart/gallery/index"
import { smartArtColorsDef, smartArtLayoutDef, smartArtStyleDef } from "../core/smartart/gallery/defs"
import { CAPABILITIES, METHOD_HANDLERS, OPENERS, PRESENTATION_LANES, SERVICES, type EngineSession } from "../dom/presentation/engine"
import { PRESENTATION_JOBS, runPresentationJob, type JobContext } from "../dom/presentation/jobs/registry"
import { PRESENTATION_METHODS, type PresentationMethod } from "../dom/presentation/protocol"
import { bytesSource, memorySink } from "../core/opc/index"
import { unavailablePresenterPortal, unavailableShowController } from "../react/presentation/show/controller"
import { fixtureBody, fixtureDeck } from "./fixtures/presentation/deck"

// The dispatch seams of the presentation engine: every family and capability is registered, routed to its own file,
// and, until its slice builds it, refuses with the typed reason notImplemented (never silently).

const slide = slideRef(10)
const target: ShapeRef = { slide, id: 2 }
const shape: ShapeNode = { id: 9, name: "Shape 8", hidden: false, kind: "sp" }

// One op per family, so the table is exhaustive by type.
const SAMPLE_OPS: { readonly [F in DeckOpFamily]: OpOf<F> } = {
	slide: { family: "slide", kind: "hide", slides: [slide], hidden: true },
	shape: { family: "shape", kind: "setXfrm", target, xfrm: { x: 0, y: 0, cx: 10, cy: 10, rot: 0, flipH: false, flipV: false } },
	text: { family: "text", kind: "setText", target, body: fixtureBody(["Edited"]) },
	table: { family: "table", kind: "insertRows", target, at: 1, count: 1 },
	picture: { family: "picture", kind: "crop", target, crop: { l: 0, t: 0, r: 10_000, b: 0 } },
	chart: { family: "chart", kind: "edit", target, edit: { kind: "title", text: "Sales" } },
	media: { family: "media", kind: "setPlayback", target, playback: { loop: true } },
	notes: { family: "notes", kind: "setNotes", slide, body: fixtureBody(["Speaker note"]) },
	comment: { family: "comment", kind: "resolve", slide, id: "{1}", resolved: true },
	timing: { family: "timing", kind: "removeEffect", slide, node: 5 },
	transition: { family: "transition", kind: "set", slides: [slide], transition: undefined },
	motionPath: { family: "motionPath", kind: "setPath", slide, node: 7, path: "M 0 0 L 0.25 0 E" },
	design: { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" },
	smartart: { family: "smartart", kind: "setNodeText", target, node: "{A}", text: "Plan" },
	ink: {
		family: "ink",
		kind: "add",
		slide,
		strokes: [{ points: new Float64Array([0, 0, 100, 100]), width: 9525, color: { kind: "srgb", rgb: "FF0000" }, highlighter: false }],
		name: "Ink"
	},
	mediaTiming: { family: "mediaTiming", kind: "setTrim", target, startMs: 0, endMs: 1000 },
	presentation: {
		family: "presentation",
		kind: "setShow",
		show: { kind: "present", loop: false, showNarration: false, showAnimation: true, useTimings: true, range: { kind: "all" } }
	}
}

// What the slices have built so far: the loops below cover only what still refuses as notImplemented.
const BUILT_APPLY: ReadonlySet<DeckOpFamily> = new Set([
	"design",
	"slide",
	"shape",
	"text",
	"table",
	"picture",
	"smartart",
	"ink",
	"media",
	"presentation",
	"transition",
	"chart",
	"timing",
	"motionPath",
	"notes",
	"comment",
	"mediaTiming"
])
const BUILT_PPTX_EMIT: ReadonlySet<DeckOpFamily> = new Set([
	"design",
	"shape",
	"slide",
	"text",
	"timing",
	"table",
	"picture",
	"smartart",
	"ink",
	"presentation",
	"transition",
	"chart",
	"motionPath",
	"notes",
	"comment",
	"mediaTiming"
])
const BUILT_ODP_EMIT: ReadonlySet<DeckOpFamily> = new Set([
	"design",
	"shape",
	"slide",
	"text",
	"timing",
	"table",
	"picture",
	"smartart",
	"ink",
	"presentation",
	"transition",
	"chart",
	"motionPath",
	"notes",
	"comment",
	"mediaTiming"
])
const BUILT_METHODS: ReadonlySet<PresentationMethod> = new Set([
	"jobsPort",
	"command",
	"undo",
	"redo",
	"save",
	"commitSaved",
	"find",
	"smartArtInfo",
	"registerMedia",
	"chartData",
	"freshParts",
	"jobsPort",
	"review",
	"retract",
	"shade",
	"clip",
	"clipParts",
	"outline"
])

const context: ApplyContext = {
	sourceBytes: () => new Uint8Array(0),
	newShapeId: () => 100,
	newSlideRef: () => slideRef(99)
}

const parts: PartsApi = {
	owner: "/ppt/slides/slide1.xml",
	addPart: () => ({ part: "/ppt/media/image9.png", rId: "rId9" }),
	relate: () => "rId1",
	target: () => undefined,
	removePart: () => undefined,
	editor: () => {
		throw new Error("no editor in this test")
	}
}

describe("presentation dispatch seams", () => {
	it("registers an apply and an emit file per op family, for both formats", () => {
		expect(Object.keys(APPLY_FAMILIES).sort()).toEqual([...DECK_OP_FAMILIES].sort())
		expect(Object.keys(PPTX_EMIT_FAMILIES).sort()).toEqual([...DECK_OP_FAMILIES].sort())
		expect(Object.keys(ODP_EMIT_FAMILIES).sort()).toEqual([...DECK_OP_FAMILIES].sort())
	})

	it("refuses every op family's apply not built yet as notImplemented, touching nothing and leaving the deck as it was", () => {
		for (const family of DECK_OP_FAMILIES.filter(family => !BUILT_APPLY.has(family))) {
			const deck = fixtureDeck()
			const before = structuredClone(deck)
			const op = SAMPLE_OPS[family]

			// A family built in part names the kind it does not apply yet.
			expect(applyOp(deck, op, context), family).toMatchObject({ kind: "refused", reason: "notImplemented" })
			expect((applyOp(deck, op, context) as { readonly detail?: string }).detail, family).toMatch(
				new RegExp(`^apply ${family}( |$)`, "u")
			)
			expect(opTouches(op), family).toEqual([])
			expect(deck, family).toEqual(before)
		}
	})

	it("refuses every family's pptx and ODP emit not built yet as notImplemented", () => {
		const deck = fixtureDeck()
		const node = deck.nodes.get(slide)

		if (node === undefined) throw new Error("fixture slide missing")

		const request = { slide: node, shape, touch: { kind: "shape", slide, shape: 9, dirt: { kind: "node" } } } as const
		const pptx: PptxEmitContext = { deck, document: undefined, parts }
		const odp: OdpEmitContext = {
			deck,
			document: undefined,
			editor: undefined,
			styles: { automatic: () => "gr1", addEntry: path => path }
		}

		for (const family of DECK_OP_FAMILIES) {
			// A family built in part (media: pictures that play, not yet frames) names what it does not write yet.
			if (!BUILT_PPTX_EMIT.has(family)) {
				const result = emitPptx(family, request, pptx)

				expect(result, family).toMatchObject({ kind: "refused", reason: "notImplemented" })
				expect((result as { readonly detail?: string }).detail, family).toMatch(new RegExp(`^pptx emit ${family}( |$)`, "u"))
			}

			if (!BUILT_ODP_EMIT.has(family)) {
				const result = emitOdp(family, request, odp)

				expect(result, family).toMatchObject({ kind: "refused", reason: "notImplemented" })
				expect((result as { readonly detail?: string }).detail, family).toMatch(new RegExp(`^odp emit ${family}( |$)`, "u"))
			} else {
				expect(emitOdp(family, request, odp), family).not.toMatchObject({ reason: "notImplemented" })
			}
		}
	})

	it("routes a dirty element to the family that writes it", () => {
		const node = fixtureDeck().nodes.get(slide)

		if (node === undefined) throw new Error("fixture slide missing")

		const on = (kind: ShapeNode["kind"], extra: Partial<ShapeNode> = {}) =>
			emitFamilyOf({
				slide: node,
				shape: { ...shape, kind, ...extra },
				touch: { kind: "shape", slide, shape: 9, dirt: { kind: "node" } }
			})
		const part = (which: "background" | "timing" | "transition" | "hf" | "clrMapOvr" | "attributes") =>
			emitFamilyOf({ slide: node, touch: { kind: "slide", slide, dirt: { kind: "slidePart", part: which } } })

		expect([on("sp"), on("grpSp"), on("cxnSp"), on("opaque"), on("pic"), on("ink")]).toEqual([
			"shape",
			"shape",
			"shape",
			"shape",
			"picture",
			"ink"
		])
		// A medium goes to the media timing family, which writes its p14:media timing into the media family's markup.
		expect(on("pic", { media: { kind: "video", contentType: "video/mp4" } })).toBe("mediaTiming")
		// A stroke of kept ink goes to the ink family while it has no source; any other new freeform stays a shape.
		const custom = { props: { geometry: { kind: "custom" as const, guides: [], paths: [] } } }

		expect(on("sp", { ...custom, ink: true })).toBe("ink")
		expect(on("sp", custom)).toBe("shape")
		expect(on("sp", { ...custom, ink: true, src: { format: "pptx", part: "/ppt/slides/slide1.xml", node: 3, epoch: 0 } })).toBe("shape")
		expect(on("frame", { frame: { kind: "chart", part: "/ppt/charts/chart1.xml" } })).toBe("chart")
		expect(on("frame", { frame: { kind: "smartart", data: "d", layout: "l", style: "s", colors: "c" } })).toBe("smartart")
		expect(
			on("frame", {
				frame: {
					kind: "table",
					table: {
						grid: [],
						rows: [],
						flags: { firstRow: false, lastRow: false, firstCol: false, lastCol: false, bandRow: false, bandCol: false }
					}
				}
			})
		).toBe("table")
		expect([part("timing"), part("transition"), part("background"), part("hf"), part("attributes"), part("clrMapOvr")]).toEqual([
			"timing",
			"transition",
			"design",
			"slide",
			"slide",
			"slide"
		])
		expect(emitFamilyOf({ slide: node, touch: { kind: "slide", slide, dirt: { kind: "node" } } })).toBe("slide")
	})

	it("routes every protocol method to a capability, each not built yet refusing as notImplemented", async () => {
		const owned = [...Object.values(CAPABILITIES).flatMap(capability => Object.keys(capability)), "smartArtPreview", "smartArtInfo"]

		expect(owned.sort()).toEqual([...PRESENTATION_METHODS].sort())
		expect(new Set(owned).size).toBe(owned.length)

		const session = { s: 1, services: SERVICES } as unknown as EngineSession
		const signal = { aborted: false, onAbort: () => undefined }
		const slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }

		for (const method of PRESENTATION_METHODS.filter(method => !BUILT_METHODS.has(method))) {
			const handler = METHOD_HANDLERS[method] as (context: unknown, ...args: unknown[]) => Promise<unknown>
			const error: unknown = await handler({ session, signal, lane: PRESENTATION_LANES[method], slicing }).then(
				() => undefined,
				(reason: unknown) => reason
			)

			expect(error, method).toBeInstanceOf(PresentationError)
			expect((error as PresentationError).reason, method).toBe("notImplemented")
		}
	})

	it("serves no embedded faces before a deck declared any, refuses SmartArt before any render as notFound, and empty bytes in every reader typed", async () => {
		const session = { s: 1 } as unknown as EngineSession

		await expect(SERVICES.fonts.faces(session)).resolves.toEqual([])
		const slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }

		await expect(SERVICES.smartart.relayout(session, target, slicing)).rejects.toMatchObject({ reason: "notFound" })
		await expect(
			SERVICES.smartart.preview(session, { uniqueId: "urn:x", source: "gallery" }, { widthPx: 96 }, slicing)
		).rejects.toBeInstanceOf(PresentationError)

		// Every reader is built: bytes that are no presentation are refused typed, never as notImplemented.
		for (const format of ["pptx", "odp", "ppt"] as const) {
			const outcome = await OPENERS[format].open({
				source: bytesSource(new Uint8Array(0)),
				sourceKind: "bytes",
				options: { format, fileName: `x.${format}` }
			})

			expect(outcome, format).toMatchObject({ kind: "refused" })
			expect(outcome, format).not.toMatchObject({ reason: "notImplemented" })
		}
	})

	it("registers the pdf, raster and convert jobs; the exports refuse as notImplemented without a jobs realm", async () => {
		expect(Object.keys(PRESENTATION_JOBS).sort()).toEqual(["convert", "pdf", "raster"])

		const job: JobContext = {
			session: {
				render: () => Promise.resolve([]),
				media: () => Promise.resolve({ kind: "refused", reason: "notImplemented" }),
				freshParts: () => Promise.resolve({ target: "pptx", bytes: 0, losses: [] })
			},
			output: memorySink(),
			signal: { aborted: false, onAbort: () => undefined },
			progress: () => undefined
		}

		expect(await runPresentationJob("pdf", { layout: "slides", includeHidden: false, protect: false }, job)).toEqual({
			kind: "refused",
			reason: "notImplemented",
			detail: "pdf job: no jobs realm"
		})
		expect(await runPresentationJob("raster", { format: "png", widthPx: 1920, zip: true }, job)).toEqual({
			kind: "refused",
			reason: "notImplemented",
			detail: "raster job: no canvas"
		})
	})

	it("refuses to start a show or open a presenter without a player", async () => {
		const show = unavailableShowController()

		expect(await show.start({ index: 0 })).toEqual({ kind: "refused", reason: "notImplemented", detail: "show" })
		expect(typeof show.on("ended", () => undefined)).toBe("function")
		expect(unavailablePresenterPortal().open()).toEqual({ kind: "refused", reason: "notImplemented", detail: "presenter" })
	})

	it("registers our SmartArt gallery, finding nothing it does not hold", () => {
		expect(SMARTART_LAYOUTS.length).toBeGreaterThanOrEqual(2)
		expect(Math.min(SMARTART_STYLES.length, SMARTART_COLORS.length)).toBeGreaterThanOrEqual(1)
		expect([smartArtLayout("urn:x"), smartArtStyle("urn:x"), smartArtColors("urn:x")]).toEqual([undefined, undefined, undefined])
		expect([smartArtLayoutDef("urn:x"), smartArtStyleDef("urn:x"), smartArtColorsDef("urn:x")]).toEqual([
			undefined,
			undefined,
			undefined
		])
	})
})
