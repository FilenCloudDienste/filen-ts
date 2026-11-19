import { describe, expect, it } from "vitest"
import type { DeckOp, FileLike, InsertedMedia } from "../core/presentation/edit/ops"
import { insertTableOp } from "../core/presentation/edit/commands/insert"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { mediaCapability } from "../dom/presentation/engine/media"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { review } from "../dom/presentation/engine/review"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences } from "./pptxWriteFixtures"
import { modelVsFile } from "./modelVsFile"
import { image } from "./presentationObjectsFixtures"

// Home ▸ New slide, then each Insert kind on that slide (SmartArt in pptx, table, chart, picture, video), then Save:
// the save writes and the file reopens with the slide and what was put on it, as on a slide the file had.

type Drive = Awaited<ReturnType<typeof driveSession>>
type Kind = "smartart" | "table" | "chart" | "picture" | "media"

const BOX: Xfrm = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }

function deckOf(format: "pptx" | "odp"): Uint8Array {
	return format === "pptx"
		? buildPptx({ slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("S"))) }] })
		: odpBytes({
				body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>S</text:p></draw:text-box></draw:frame></draw:page>'
			})
}

function video(): FileLike {
	const bytes = new Uint8Array(4096)

	bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31], 0)

	return {
		size: bytes.length,
		name: "clip.mp4",
		type: "video/mp4",
		slice: (start = 0, end = bytes.length) => ({ arrayBuffer: () => Promise.resolve(bytes.slice(start, end).buffer) })
	}
}

async function insertOn(d: Drive, slide: SlideRef, kind: Kind): Promise<DeckOp> {
	const shape = (name: string, type: ShapeNode["kind"]): ShapeNode => ({ id: 0, name, hidden: false, kind: type, xfrm: BOX }) as ShapeNode

	switch (kind) {
		case "smartart":
			return {
				family: "smartart",
				kind: "insert",
				slide,
				shape: shape("Diagram", "frame"),
				layout: { uniqueId: "urn:filen:smartart:layout:venn", source: "gallery" },
				texts: ["Alpha", "Beta", "Gamma"]
			}
		case "table":
			return insertTableOp(d.session.deck, slide, 2, 2, 90) as DeckOp
		case "chart":
			return {
				family: "chart",
				kind: "insert",
				slide,
				shape: shape("Chart", "frame"),
				type: "bar",
				cells: [
					["", "Sales"],
					["Q1", 4],
					["Q2", 7]
				]
			}
		case "picture":
			return { family: "picture", kind: "insert", slide, shape: shape("Picture", "pic"), image: image(16, 9) }
		case "media": {
			const registered = await mediaCapability.registerMedia(d.context, { kind: "file", file: video() })

			if ("reason" in registered) throw new Error(registered.reason)

			const media: InsertedMedia = { ...registered, poster: image(16, 9), durationMs: 1000 }

			return { family: "media", kind: "insert", slide, shape: shape("clip.mp4", "pic"), media }
		}
	}
}

async function newSlide(d: Drive): Promise<SlideRef> {
	const first = d.session.deck.slides[0] as SlideRef

	await review(d.context, first)

	const before = new Set(d.session.deck.slides)
	const layout = (d.session.deck.nodes.get(first) as SlideNode).parent as SlideRef

	expect((await d.command({ family: "slide", kind: "add", at: 1, layout })).ok).toBe(true)

	return d.session.deck.slides.find(ref => !before.has(ref)) as SlideRef
}

// Whether `shape` is what inserting `kind` puts on a slide, as a fresh open reads it (a layout's placeholders are none).
function isKind(shape: ShapeNode, kind: Kind): boolean {
	switch (kind) {
		case "smartart":
		case "table":
		case "chart":
			return shape.frame?.kind === kind
		case "picture":
			return shape.kind === "pic" && shape.media === undefined && shape.frame === undefined
		case "media":
			return shape.media !== undefined || shape.frame?.kind === "media"
	}
}

async function reopenedKinds(bytes: Uint8Array, format: "pptx" | "odp", at: number): Promise<Kind[]> {
	const again = await driveSession(bytes, format)
	const reread = again.session.deck.slides[at] as SlideRef

	await review(again.context, reread)

	const shapes = (again.session.deck.nodes.get(reread) as SlideNode).shapes
	const kinds: Kind[] = ["smartart", "table", "chart", "picture", "media"]

	return kinds.filter(kind => shapes.some(shape => isKind(shape, kind)))
}

async function saved(d: Drive, format: "pptx" | "odp"): Promise<Uint8Array> {
	const result = await d.save()

	expect(result.result).toEqual(expect.objectContaining({ kind: "written" }))

	if (result.bytes === undefined) throw new Error("not saved")
	if (format === "pptx") expect(await danglingReferences(result.bytes)).toEqual([])

	return result.bytes
}

describe("a new slide with something inserted, then saved", () => {
	for (const format of ["pptx", "odp"] as const) {
		const kinds: Kind[] =
			format === "pptx" ? ["smartart", "table", "chart", "picture", "media"] : ["table", "chart", "picture", "media"]

		for (const kind of kinds)
			it(`${format}: ${kind} on a new slide is written and reads back`, async () => {
				const d = await driveSession(deckOf(format), format)

				if (format === "pptx")
					smartArtRenderer(d.session, {
						services: {
							xml: part => pptxParts(d.session.deck)?.document(part),
							relationship: () => undefined,
							contentType: () => undefined
						}
					})

				const slide = await newSlide(d)

				expect((await d.command(await insertOn(d, slide, kind))).ok, kind).toBe(true)

				const bytes = await saved(d, format)

				expect(await modelVsFile(d, bytes, format)).toBe("")
				expect(await reopenedKinds(bytes, format, 1)).toEqual([kind])

				// Every kind together on another new slide, saved after the first.
				const more = await newSlide(d)

				for (const each of kinds) expect((await d.command(await insertOn(d, more, each))).ok, each).toBe(true)

				const all = await saved(d, format)
				const at = d.session.deck.slides.indexOf(more)

				expect(await modelVsFile(d, all, format)).toBe("")
				expect(await reopenedKinds(all, format, at)).toEqual(kinds)
			})
	}
})
