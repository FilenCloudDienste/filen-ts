import { describe, expect, it } from "vitest"
import type { DeckOp, FileLike } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef, TextBody, Xfrm } from "../core/presentation/model"
import { mediaCapability } from "../dom/presentation/engine/media"
import { driveSession } from "./odpWriteDrive"
import { buildPptx, body, para, sp } from "./pptxFixtures"
import { partsOf } from "./pptxWriteFixtures"
import { designOdp } from "./presentationDesignFixtures"
import { image } from "./presentationObjectsFixtures"

// A part a save writes for the session (a first notes master's theme, a slide's first comments, a background tile, an
// inserted picture or medium), taken out by the save after an undo and written again after the redo, is the same
// logical part (the same owner and role, or the same content): it takes back the name it had, so the same state saved
// again is the same bytes. No other part ever takes that name.

type Drive = Awaited<ReturnType<typeof driveSession>>

const BOX: Xfrm = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }

function plain(text: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }
}

function clip(): FileLike {
	const bytes = new Uint8Array(4096).map((_, k) => (k * 7) & 0xff)

	bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31], 0)

	return {
		size: bytes.length,
		name: "clip.mp4",
		type: "video/mp4",
		slice: (start = 0, end = bytes.length) => ({ arrayBuffer: () => Promise.resolve(bytes.slice(start, end).buffer) })
	}
}

async function written(d: Drive): Promise<Map<string, Uint8Array>> {
	const outcome = await d.save()

	if (outcome.result.kind !== "written" || outcome.bytes === undefined) throw new Error(JSON.stringify(outcome.result))

	return partsOf(outcome.bytes)
}

const pptxDeck = (): Uint8Array => buildPptx({ slides: [{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("One"))) }] })

const CASES: Record<
	string,
	{ readonly format: "pptx" | "odp"; readonly deck: () => Promise<Uint8Array>; readonly op: (d: Drive) => Promise<DeckOp> }
> = {
	"a first notes master's theme (pptx)": {
		format: "pptx",
		deck: () => Promise.resolve(pptxDeck()),
		op: d =>
			Promise.resolve({
				family: "notes",
				kind: "setNotes",
				slide: d.session.deck.slides[0] as SlideRef,
				body: plain("note")
			} as DeckOp)
	},
	"a slide's first comments (pptx)": {
		format: "pptx",
		deck: () => Promise.resolve(pptxDeck()),
		op: d =>
			Promise.resolve({
				family: "comment",
				kind: "add",
				slide: d.session.deck.slides[0] as SlideRef,
				comment: {
					id: "{33333333-3333-4333-8333-333333333333}",
					author: "{22222222-2222-4222-8222-222222222222}",
					text: "c",
					created: "2026-10-28T08:00:00.000Z",
					anchor: { x: 12_700, y: 25_400 }
				},
				authorName: "Cy Doe"
			})
	},
	"a background tile (ODP)": {
		format: "odp",
		deck: () => designOdp(2),
		op: () =>
			Promise.resolve({
				family: "design",
				kind: "setBackground",
				slides: "all",
				background: {
					kind: "fill",
					fill: { kind: "pattern", preset: "dkUpDiag", fg: { kind: "srgb", rgb: "000080" }, bg: { kind: "srgb", rgb: "FFFFFF" } }
				}
			})
	},
	"an inserted picture (ODP)": {
		format: "odp",
		deck: () => designOdp(1),
		op: d =>
			Promise.resolve({
				family: "picture",
				kind: "insert",
				slide: d.session.deck.slides[0] as SlideRef,
				shape: { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
				image: image(64, 32)
			})
	},
	"an inserted medium and its poster (ODP)": {
		format: "odp",
		deck: () => designOdp(1),
		op: async d => {
			const registered = await mediaCapability.registerMedia(d.context, { kind: "file", file: clip() })

			if ("reason" in registered) throw new Error(registered.reason)

			return {
				family: "media",
				kind: "insert",
				slide: d.session.deck.slides[0] as SlideRef,
				shape: { id: 0, name: "clip.mp4", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
				media: { ...registered, poster: image(16, 9), durationMs: 1000 }
			}
		}
	}
}

describe("a part a save wrote, taken out after an undo and written again after the redo", () => {
	for (const [what, given] of Object.entries(CASES))
		it(`keeps its name: ${what}`, async () => {
			const d = await driveSession(await given.deck(), given.format)

			expect((await d.command(await given.op(d))).ok).toBe(true)

			const first = await written(d)

			expect((await d.undo()).ok).toBe(true)
			await written(d)
			expect((await d.redo()).ok).toBe(true)

			const again = await written(d)

			expect([...again.keys()].sort()).toEqual([...first.keys()].sort())

			for (const [name, bytes] of first) expect(Buffer.from(again.get(name) ?? []).equals(Buffer.from(bytes)), name).toBe(true)
		})
})
