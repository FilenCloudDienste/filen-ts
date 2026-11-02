import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// Saves the page starts back to back (a double Mod+S, an autosave meeting Mod+S), each its own save and commit as the
// page runs them: the later one waits for the earlier to land, then saves against the file it made. No save is
// refused for the overlap, no edit is undone, and the last file holds every edit.

type Drive = Awaited<ReturnType<typeof driveSession>>
type Format = "pptx" | "odp"

function deckOf(format: Format): Uint8Array {
	return format === "pptx"
		? buildPptx({ slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("S"))) }] })
		: odpBytes({
				body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>S</text:p></draw:text-box></draw:frame></draw:page>'
			})
}

async function opened(format: Format): Promise<{ d: Drive; slide: SlideRef; shape: ShapeNode }> {
	const d = await driveSession(deckOf(format), format)
	const slide = d.session.deck.slides[0] as SlideRef

	await review(d.context, slide)

	return { d, slide, shape: (d.session.deck.nodes.get(slide) as SlideNode).shapes[0] as ShapeNode }
}

// The shape moved right by `step` from where it is now.
async function nudge(d: Drive, slide: SlideRef, id: number, step: number): Promise<void> {
	const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.id === id) as ShapeNode
	const box = shape.xfrm as Xfrm

	expect((await d.command({ family: "shape", kind: "setXfrm", target: { slide, id }, xfrm: { ...box, x: box.x + step } })).ok).toBe(true)
}

function xOf(d: Drive, slide: SlideRef, id: number): number {
	return ((d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.id === id)?.xfrm as Xfrm).x
}

// The shape's x in a saved file, read back by a session of its own.
async function savedX(bytes: Uint8Array | undefined, format: Format, id: number): Promise<number> {
	if (bytes === undefined) throw new Error("no saved file")

	const again = await driveSession(bytes, format)
	const slide = again.session.deck.slides[0] as SlideRef

	await review(again.context, slide)

	return xOf(again, slide, id)
}

describe("saves started back to back", () => {
	for (const format of ["odp", "pptx"] as const) {
		it(`${format}: two saves at 0 ms, each with an edit before it: neither refused, no edit undone, the last file holds both`, async () => {
			const { d, slide, shape } = await opened(format)
			const start = xOf(d, slide, shape.id)

			await nudge(d, slide, shape.id, 12_700)

			const first = d.save()

			await nudge(d, slide, shape.id, 12_700)

			const second = d.save()
			const [a, b] = await Promise.all([first, second])

			expect(a.result.kind).toBe("written")
			expect(["written", "unchanged"]).toContain(b.result.kind)
			expect(xOf(d, slide, shape.id)).toBe(start + 25_400)

			const last = b.result.kind === "written" ? b.bytes : a.bytes

			expect(await savedX(last, format, shape.id)).toBe(start + 25_400)
			expect((await d.save()).result.kind).toBe("unchanged")
		})

		it(`${format}: three saves at 0 ms with edits between and after: none refused, every edit kept and saved`, async () => {
			const { d, slide, shape } = await opened(format)
			const start = xOf(d, slide, shape.id)
			const saves: ReturnType<Drive["save"]>[] = []

			for (let at = 0; at < 3; at++) {
				await nudge(d, slide, shape.id, 12_700)
				saves.push(d.save())
			}

			await nudge(d, slide, shape.id, 12_700)

			const results = await Promise.all(saves)

			for (const each of results) expect(["written", "unchanged"]).toContain(each.result.kind)
			expect(results.filter(each => each.result.kind === "written").length).toBeGreaterThan(0)
			expect(xOf(d, slide, shape.id)).toBe(start + 4 * 12_700)

			// A save queued behind the others takes its snapshot when its turn comes: the edit after them may be in it.
			const last = await d.save()
			const files = [...results, last].filter(each => each.result.kind === "written")

			expect(await savedX(files.at(-1)?.bytes, format, shape.id)).toBe(start + 4 * 12_700)
			expect((await d.save()).result.kind).toBe("unchanged")
		})
	}

	for (const format of ["odp", "pptx"] as const)
		it(`${format}: a save asked for while an edit is still queued writes that edit`, async () => {
			const { d, slide, shape } = await opened(format)
			const start = xOf(d, slide, shape.id)
			const box = shape.xfrm as Xfrm
			const edit = d.command({
				family: "shape",
				kind: "setXfrm",
				target: { slide, id: shape.id },
				xfrm: { ...box, x: box.x + 12_700 }
			})
			const saved = await d.save()

			expect((await edit).ok).toBe(true)
			expect(saved.result.kind).toBe("written")
			expect(await savedX(saved.bytes, format, shape.id)).toBe(start + 12_700)
		})

	it("pptx: an edit reading the old file after a save it waited for was never committed in time: a typed answer, then it works", async () => {
		const d = await driveSession(
			buildPptx({
				slides: [0, 1, 2].map(at => ({
					shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(at)}`)))
				}))
			}),
			"pptx",
			[],
			{ commitWaitMs: 20, inMemoryLimit: 0 }
		)
		const [first, , last] = d.session.deck.slides as SlideRef[]

		await review(d.context, first as SlideRef)

		const id = ((d.session.deck.nodes.get(first as SlideRef) as SlideNode).shapes[0] as ShapeNode).id

		await nudge(d, first as SlideRef, id, 12_700)

		const saved = await d.begin()

		expect(saved.result.kind).toBe("written")

		// The last slide was never read: duplicating it reads the old file, which the save's upload deleted.
		const copy = await d.command({ family: "slide", kind: "duplicate", slide: last as SlideRef }).then(
			result => (result.ok ? "ok" : `refused ${String(result.refusal)}`),
			(error: unknown) => `threw ${String(error)}`
		)

		expect(["ok", "refused stale"]).toContain(copy)
		await saved.commit()
		expect((await d.command({ family: "slide", kind: "duplicate", slide: last as SlideRef })).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
	})

	// The page never commits a written save in time, and the old file is gone (versioning off).
	for (const format of ["odp", "pptx"] as const)
		for (const kept of [true, false])
			it(`${format}: a written save not committed in time, the old file gone${kept ? "" : ", the zip not kept"}: the session saves on, the late commit harmless`, async () => {
				const d = await driveSession(deckOf(format), format, [], { commitWaitMs: 20, ...(kept ? {} : { inMemoryLimit: 0 }) })
				const slide = d.session.deck.slides[0] as SlideRef

				await review(d.context, slide)

				const id = ((d.session.deck.nodes.get(slide) as SlideNode).shapes[0] as ShapeNode).id
				const start = xOf(d, slide, id)

				await nudge(d, slide, id, 12_700)

				const first = await d.begin()

				expect(first.result.kind).toBe("written")
				await nudge(d, slide, id, 12_700)

				const second = await d.begin()

				if (kept) {
					// The session moved onto the file the first save made, from the zip it kept: the second writes on it.
					expect(second.result.kind).toBe("written")
					await second.commit()
					await expect(first.commit()).resolves.toBeDefined()
				} else {
					// Nothing to read the old file's parts from: one refusal, and the late commit still lands.
					expect(second.result.kind).toBe("refused")
					expect(second.result).not.toEqual({ kind: "refused", reason: "proofFailed" })
					await first.commit()
				}

				const last = await d.save()
				const files = [second, last].filter(each => each.result.kind === "written")

				expect(await savedX(files.at(-1)?.bytes, format, id)).toBe(start + 25_400)
				expect(xOf(d, slide, id)).toBe(start + 25_400)
				expect((await d.save()).result.kind).toBe("unchanged")
			})

	// Commands run between a save's snapshot and its landing (the upload held after its last byte), as an edit burst
	// does while a save writes.
	describe("edits while a save writes", () => {
		async function deck(): Promise<{ d: Drive; layout: SlideRef }> {
			const d = await driveSession(
				buildPptx({
					slides: [0, 1, 2].map(at => ({
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(at)}`)))
					}))
				}),
				"pptx"
			)

			for (const slide of d.session.deck.slides) await review(d.context, slide)

			return { d, layout: (d.session.deck.nodes.get(d.session.deck.slides[0] as SlideRef) as SlideNode).parent as SlideRef }
		}

		// Starts a save, runs `during` while its upload is held, then lets it land and commits it.
		async function savedWhile(d: Drive, during: () => Promise<void>): Promise<void> {
			const release = d.drive.hold()
			const begun = d.begin()

			await during()
			release()

			const done = await begun

			expect(done.result.kind).toBe("written")
			await done.commit()
		}

		async function settled(d: Drive): Promise<void> {
			const last = await d.save()

			expect(last.result.kind).toBe("written")
			expect((await d.save()).result.kind).toBe("unchanged")
		}

		it("pptx: a slide added, saved while it is deleted, the delete undone, then edited: every later save writes", async () => {
			const { d, layout } = await deck()

			expect((await d.command({ family: "slide", kind: "add", at: 1, layout })).ok).toBe(true)

			const added = d.session.deck.slides[1] as SlideRef

			await savedWhile(d, async () => {
				expect((await d.command({ family: "slide", kind: "delete", slides: [added] })).ok).toBe(true)
			})
			expect((await d.undo()).ok).toBe(true)
			expect(d.session.deck.slides).toContain(added)
			expect((await d.command({ family: "slide", kind: "hide", slides: [added], hidden: true })).ok).toBe(true)
			await settled(d)
			expect((await d.command({ family: "slide", kind: "move", slides: [added], to: 0 })).ok).toBe(true)
			await settled(d)
		})

		it("pptx: a slide deleted and saved, its delete undone, moved and saved, moved again and saved: no edit undone", async () => {
			const { d } = await deck()
			const slide = d.session.deck.slides[0] as SlideRef
			const id = ((d.session.deck.nodes.get(slide) as SlideNode).shapes[0] as ShapeNode).id
			const start = xOf(d, slide, id)

			await nudge(d, slide, id, 12_700)
			expect((await d.command({ family: "slide", kind: "delete", slides: [slide] })).ok).toBe(true)
			expect((await d.save()).result.kind).toBe("written")
			expect((await d.undo()).ok).toBe(true)
			await review(d.context, slide)
			await savedWhile(d, async () => {
				await nudge(d, slide, id, 12_700)
			})
			await nudge(d, slide, id, 12_700)

			const last = await d.save()

			expect(last.result.kind).toBe("written")
			expect(xOf(d, slide, id)).toBe(start + 3 * 12_700)
			expect(await savedX(last.bytes, "pptx", id)).toBe(start + 3 * 12_700)
		})

		it("pptx: a copy moved while the save that first writes it lands, then its text edited: the edit is made", async () => {
			const { d } = await deck()
			const slide = d.session.deck.slides[0] as SlideRef

			expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

			const copy = d.session.deck.slides[1] as SlideRef
			const shape = (d.session.deck.nodes.get(copy) as SlideNode).shapes[0] as ShapeNode

			await savedWhile(d, async () => {
				await nudge(d, copy, shape.id, 12_700)
			})

			const text = (d.session.deck.nodes.get(copy) as SlideNode).shapes[0]?.text

			expect(
				(
					await d.command({
						family: "text",
						kind: "setText",
						target: { slide: copy, id: shape.id },
						body: {
							...text,
							bodyPr: text?.bodyPr ?? {},
							paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "Edited", rPr: {} }] }]
						}
					})
				).ok
			).toBe(true)
			await settled(d)
		})

		// An edit burst with saves among it, each sent without waiting for the one before, 5 ms apart (a fix-check trace
		// on a five-slide deck): a slide deleted, saved, restored by an undo and saved again, with moves around it.
		// Slide refs as the deck hands them out (plain numbers in the trace).
		const BURST = [
			{ t: "op", op: { family: "slide", kind: "duplicate", slide: 4 } },
			{ t: "op", op: { family: "slide", kind: "hide", slides: [1073741824], hidden: true } },
			{
				t: "op",
				op: {
					family: "shape",
					kind: "setXfrm",
					target: { slide: 6, id: 2 },
					xfrm: { x: 112700, y: 100000, cx: 3000000, cy: 500000, rot: 0, flipH: false, flipV: false }
				}
			},
			{
				t: "op",
				op: {
					family: "shape",
					kind: "setXfrm",
					target: { slide: 6, id: 2 },
					xfrm: { x: 125400, y: 100000, cx: 3000000, cy: 500000, rot: 0, flipH: false, flipV: false }
				}
			},
			{ t: "op", op: { family: "slide", kind: "delete", slides: [4] } },
			{ t: "save" },
			{ t: "undo" },
			{ t: "op", op: { family: "slide", kind: "add", at: 2, layout: 2 } },
			{ t: "redo" },
			{
				t: "op",
				op: {
					family: "text",
					kind: "setText",
					target: { slide: 7, id: 2 },
					body: { bodyPr: {}, lstStyle: { levels: [] }, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "T10", rPr: {} }] }] }
				}
			},
			{
				t: "op",
				op: {
					family: "shape",
					kind: "setXfrm",
					target: { slide: 8, id: 2 },
					xfrm: { x: 112700, y: 100000, cx: 3000000, cy: 500000, rot: 0, flipH: false, flipV: false }
				}
			},
			{ t: "save" },
			{ t: "op", op: { family: "slide", kind: "move", slides: [1073741824], to: 2 } },
			{
				t: "op",
				op: {
					family: "shape",
					kind: "setXfrm",
					target: { slide: 4, id: 2 },
					xfrm: { x: 112700, y: 100000, cx: 3000000, cy: 500000, rot: 0, flipH: false, flipV: false }
				}
			},
			{ t: "op", op: { family: "slide", kind: "add", at: 7, layout: 2 } },
			{ t: "save" },
			{ t: "save" },
			{ t: "op", op: { family: "slide", kind: "move", slides: [5], to: 2 } },
			{ t: "op", op: { family: "slide", kind: "duplicate", slide: 7 } },
			{ t: "op", op: { family: "slide", kind: "delete", slides: [7] } },
			{ t: "redo" },
			{
				t: "op",
				op: {
					family: "text",
					kind: "setText",
					target: { slide: 1073741825, id: 2 },
					body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "T22", rPr: {} }] }] }
				}
			},
			{ t: "redo" },
			{ t: "op", op: { family: "slide", kind: "delete", slides: [8] } }
		] as unknown as readonly ({ readonly t: "op"; readonly op: DeckOp } | { readonly t: "save" | "undo" | "redo" })[]

		it("pptx: a burst of edits with saves among it, 5 ms apart, three times: every save writes, no edit undone", async () => {
			for (let run = 0; run < 3; run++) {
				const d = await driveSession(
					buildPptx({
						slides: [0, 1, 2, 3, 4].map(at => ({
							shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(at)}`)))
						}))
					}),
					"pptx"
				)

				for (const slide of d.session.deck.slides) await review(d.context, slide)

				const answers: Promise<string>[] = []

				for (const action of BURST) {
					if (action.t === "save")
						answers.push(
							d.begin().then(async begun => {
								await begun.commit()

								return begun.result.kind
							})
						)
					else if (action.t === "op") answers.push(d.command(action.op).then(result => String(result.ok)))
					else answers.push((action.t === "undo" ? d.undo() : d.redo()).then(result => String(result.ok)))

					await new Promise(resolve => setTimeout(resolve, 5))
				}

				expect(
					(await Promise.all(answers)).filter(answer => answer !== "true" && answer !== "written" && answer !== "unchanged")
				).toEqual([])
				expect(["written", "unchanged"]).toContain((await d.save()).result.kind)
				expect((await d.save()).result.kind).toBe("unchanged")
			}
		})
	})
})
