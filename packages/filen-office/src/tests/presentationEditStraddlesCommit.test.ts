import { MessageChannel } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import type { CommandResult } from "../dom/presentation/protocol"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { review } from "../dom/presentation/engine/review"
import { SAVE_DEPENDENCIES } from "../dom/presentation/engine/save"
import { commitSavedSession, saveSession } from "../dom/presentation/save"
import { savePortAnnounced, type SavePortEnd } from "@filen/shared/savePort"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { editDeckOptions } from "./presentationEditFixtures"

// An op whose turn began before a save's upload landed and whose reads of the file wait on the save's hold: they resume
// after the commit against the file the save made, where the parts the save rewrote are not the ones read before.
// Refused, that attempt changed nothing; the op runs once more against the file as it is now, and stays.

type Drive = Awaited<ReturnType<typeof driveSession>>

async function nudge(d: Drive, slide: SlideRef): Promise<void> {
	await review(d.context, slide)

	const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes[0] as ShapeNode
	const box = shape.xfrm as Xfrm

	expect(
		(await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: shape.id }, xfrm: { ...box, x: box.x + 12_700 } })).ok
	).toBe(true)
}

describe("an op read across a save's commit", () => {
	for (const target of [0, 1])
		it(`pptx: deleting slide ${String(target + 1)}, its reads held until the commit, deletes it, and the next save writes that`, async () => {
			const d = await driveSession(
				buildPptx({
					slides: Array.from({ length: 3 }, (_, k) => ({
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(k)}`)))
					}))
				}),
				"pptx"
			)
			const slides = [...d.session.deck.slides]

			// Every slide's part rewritten by the save.
			for (const slide of slides) await nudge(d, slide)

			const history = sessionEdits(d.session).history
			const depth = history.depth.undo
			// The op's reads wait until the save has answered (its upload landed): they then wait on its hold.
			const source = d.session.package.source as { read: (offset: number, length: number) => Promise<Uint8Array> }
			const read = source.read.bind(source)
			let park: Promise<unknown> | undefined

			source.read = async (offset, length) => {
				if (park !== undefined) await park

				return read(offset, length)
			}

			const { port1, port2 } = new MessageChannel()
			const answered = Promise.withResolvers<void>()
			let deleted: Promise<CommandResult> | undefined
			const uploading = savePortAnnounced(port2 as unknown as SavePortEnd).then(async write => {
				if (!write) return undefined

				const uuid = await d.drive.upload(port2, undefined)

				// The writer has read all it needs: the op's turn starts now, before the save lands.
				park = answered.promise
				deleted = d.command({ family: "slide", kind: "delete", slides: [slides[target] as SlideRef] })
				await new Promise(resolve => setTimeout(resolve, 0))

				return uuid
			})
			const result = await saveSession(d.context, { reason: "user", port: port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)
			const uuid = await uploading

			port1.close()
			port2.close()
			answered.resolve()
			park = undefined

			expect(result.kind).toBe("written")
			expect(uuid).toBeDefined()

			await commitSavedSession(
				d.context,
				{
					file: { uuid: uuid as string, name: "deck.pptx" },
					port: { uuid, postMessage: () => undefined, close: () => undefined } as never,
					size: d.drive.files.get(uuid as string)?.length ?? 0,
					revision: result.kind === "written" ? result.revision : 0
				},
				SAVE_DEPENDENCIES
			)

			expect((await deleted)?.ok).toBe(true)
			// One step, the delete's.
			expect(history.depth.undo).toBe(depth + 1)
			expect(d.session.deck.slides).toEqual(slides.filter((_, k) => k !== target))

			const next = await d.save()

			expect(next.result.kind).toBe("written")
			expect((await driveSession(next.bytes as Uint8Array, "pptx")).session.deck.slides.length).toBe(2)
			expect((await d.save()).result.kind).toBe("unchanged")
		})
})

// A slide deleted while a save writes (the file it makes still has it), then restored by an undo after the commit:
// its parts are the new file's byte for byte, so an edit of it reads them there.
describe("a slide deleted during a save's write and restored after its commit", () => {
	for (const commented of [false, true])
		it(`pptx${commented ? " (a comment added first)" : ""}: typing on the restored slide is made and written`, async () => {
			const d = await driveSession(buildPptx(editDeckOptions()), "pptx")

			for (const slide of d.session.deck.slides) await review(d.context, slide)

			const [first, second] = d.session.deck.slides as [SlideRef, SlideRef]

			expect((await d.command({ family: "slide", kind: "duplicate", slide: second })).ok).toBe(true)

			if (commented)
				expect(
					(
						await d.command({
							family: "comment",
							kind: "add",
							slide: second,
							comment: {
								id: "{10000015-7777-4777-8777-1000000003ee}",
								author: "{22222222-2222-4222-8222-222222222222}",
								text: "c21",
								created: "2026-10-28T08:00:00.000Z",
								anchor: { x: 0, y: 0 }
							},
							authorName: "Fz"
						})
					).ok
				).toBe(true)

			const saving = d.begin().then(begun => begun.commit())

			expect((await d.command({ family: "slide", kind: "delete", slides: [first] })).ok).toBe(true)
			await saving
			expect((await d.undo()).ok).toBe(true)

			const shape = (d.session.deck.nodes.get(first) as SlideNode).shapes.find(each => each.text !== undefined) as ShapeNode
			const typed = await d.command({
				family: "text",
				kind: "setText",
				target: { slide: first, id: shape.id },
				body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "T25", rPr: {} }] }] }
			})

			expect(typed.ok).toBe(true)

			const next = await d.save()

			expect(next.result.kind).toBe("written")

			const back = await driveSession(next.bytes as Uint8Array, "pptx")
			const slide = back.session.deck.slides[0] as SlideRef

			await review(back.context, slide)
			expect(JSON.stringify((back.session.deck.nodes.get(slide) as SlideNode).shapes)).toContain("T25")
		})
})

// A save in flight that writes a slide's delete, and an undo that restores the slide before that save commits: the
// restore binds to the file as it was, which the commit replaces with one that has no such slide. The restored slide
// still edits and saves whole (its held parts are its source then).
describe("a slide restored while the save that writes its delete is in flight", () => {
	for (const deleted of ["before the save", "during the save's write"] as const)
		it(`pptx: deleted ${deleted}: typing on it after the commit is made, and the next save writes it whole`, async () => {
			const d = await driveSession(buildPptx(editDeckOptions()), "pptx")

			for (const slide of d.session.deck.slides) await review(d.context, slide)

			const first = d.session.deck.slides[0] as SlideRef
			const shapes = (d.session.deck.nodes.get(first) as SlideNode).shapes.length

			if (deleted === "before the save") expect((await d.command({ family: "slide", kind: "delete", slides: [first] })).ok).toBe(true)
			else
				expect(
					(await d.command({ family: "slide", kind: "hide", slides: [d.session.deck.slides[1] as SlideRef], hidden: true })).ok
				).toBe(true)

			const { port1, port2 } = new MessageChannel()
			const uploading = savePortAnnounced(port2 as unknown as SavePortEnd).then(async write => {
				if (!write) return undefined

				if (deleted === "during the save's write")
					expect((await d.command({ family: "slide", kind: "delete", slides: [first] })).ok).toBe(true)

				// The undo lands before the upload does: the package is still the old file.
				expect((await d.undo()).ok).toBe(true)

				return d.drive.upload(port2, undefined)
			})
			const result = await saveSession(d.context, { reason: "user", port: port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)
			const uuid = await uploading

			port1.close()
			port2.close()
			expect(result.kind).toBe("written")
			await commitSavedSession(
				d.context,
				{
					file: { uuid: uuid as string, name: "deck.pptx" },
					port: { uuid, postMessage: () => undefined, close: () => undefined } as never,
					size: d.drive.files.get(uuid as string)?.length ?? 0,
					revision: result.kind === "written" ? result.revision : 0
				},
				SAVE_DEPENDENCIES
			)

			const shape = (d.session.deck.nodes.get(first) as SlideNode).shapes.find(each => each.text !== undefined) as ShapeNode

			expect(
				(
					await d.command({
						family: "text",
						kind: "setText",
						target: { slide: first, id: shape.id },
						body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "T25", rPr: {} }] }] }
					})
				).ok
			).toBe(true)

			const next = await d.save()

			expect(next.result.kind).toBe("written")

			const back = await driveSession(next.bytes as Uint8Array, "pptx")
			const slide = back.session.deck.slides[0] as SlideRef

			await review(back.context, slide)

			const node = back.session.deck.nodes.get(slide) as SlideNode

			expect(node.shapes).toHaveLength(shapes)
			expect(JSON.stringify(node.shapes)).toContain("T25")
		})

	it("pptx: deleted before the save, restored and typed on while its upload is still on its way: the next save writes the text", async () => {
		const d = await driveSession(buildPptx(editDeckOptions()), "pptx")

		for (const slide of d.session.deck.slides) await review(d.context, slide)

		const first = d.session.deck.slides[0] as SlideRef
		const shapes = (d.session.deck.nodes.get(first) as SlideNode).shapes.length

		expect((await d.command({ family: "slide", kind: "delete", slides: [first] })).ok).toBe(true)

		const { port1, port2 } = new MessageChannel()
		const uploading = savePortAnnounced(port2 as unknown as SavePortEnd).then(async write => {
			if (!write) return undefined

			expect((await d.undo()).ok).toBe(true)

			const shape = (d.session.deck.nodes.get(first) as SlideNode).shapes.find(each => each.text !== undefined) as ShapeNode

			expect(
				(
					await d.command({
						family: "text",
						kind: "setText",
						target: { slide: first, id: shape.id },
						body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "T25", rPr: {} }] }] }
					})
				).ok
			).toBe(true)

			return d.drive.upload(port2, undefined)
		})
		const result = await saveSession(d.context, { reason: "user", port: port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)
		const uuid = await uploading

		port1.close()
		port2.close()
		await commitSavedSession(
			d.context,
			{
				file: { uuid: uuid as string, name: "deck.pptx" },
				port: { uuid, postMessage: () => undefined, close: () => undefined } as never,
				size: d.drive.files.get(uuid as string)?.length ?? 0,
				revision: result.kind === "written" ? result.revision : 0
			},
			SAVE_DEPENDENCIES
		)

		const next = await d.save()

		expect(next.result.kind).toBe("written")

		const back = await driveSession(next.bytes as Uint8Array, "pptx")
		const slide = back.session.deck.slides[0] as SlideRef

		await review(back.context, slide)

		const node = back.session.deck.nodes.get(slide) as SlideNode

		expect(node.shapes).toHaveLength(shapes)
		expect(JSON.stringify(node.shapes)).toContain("T25")
	})

	it("pptx: restored during the save and saved again with no edit between: written whole", async () => {
		const d = await driveSession(buildPptx(editDeckOptions()), "pptx")

		for (const slide of d.session.deck.slides) await review(d.context, slide)

		const first = d.session.deck.slides[0] as SlideRef
		const shapes = (d.session.deck.nodes.get(first) as SlideNode).shapes.length

		expect((await d.command({ family: "slide", kind: "delete", slides: [first] })).ok).toBe(true)

		const { port1, port2 } = new MessageChannel()
		const uploading = savePortAnnounced(port2 as unknown as SavePortEnd).then(async write => {
			if (!write) return undefined

			expect((await d.undo()).ok).toBe(true)

			return d.drive.upload(port2, undefined)
		})
		const result = await saveSession(d.context, { reason: "user", port: port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)
		const uuid = await uploading

		port1.close()
		port2.close()
		await commitSavedSession(
			d.context,
			{
				file: { uuid: uuid as string, name: "deck.pptx" },
				port: { uuid, postMessage: () => undefined, close: () => undefined } as never,
				size: d.drive.files.get(uuid as string)?.length ?? 0,
				revision: result.kind === "written" ? result.revision : 0
			},
			SAVE_DEPENDENCIES
		)

		const next = await d.save()

		expect(next.result.kind).toBe("written")

		const back = await driveSession(next.bytes as Uint8Array, "pptx")

		await review(back.context, back.session.deck.slides[0] as SlideRef)
		expect((back.session.deck.nodes.get(back.session.deck.slides[0] as SlideRef) as SlideNode).shapes).toHaveLength(shapes)
	})
})
