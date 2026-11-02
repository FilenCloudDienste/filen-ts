import { MessageChannel } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { SAVE_DEPENDENCIES } from "../dom/presentation/engine/save"
import { commitSavedSession, rebasableSource, saveSession } from "../dom/presentation/save"
import { savePortAnnounced, type SavePortEnd } from "../dom/presentation/savePort"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// A slide deleted, duplicated, added, moved or hidden while a save is being written or uploaded: the save lands and
// the session moves onto the file it made, the edit stays, and the next save writes it (the saved file is the deck).
// Edits after the save's snapshot are the next save's.

type Drive = Awaited<ReturnType<typeof driveSession>>
type Format = "pptx" | "odp"
type When = "while it is written" | "as its upload begins, finishing after the commit" | "after its upload, before its commit"

function deckOf(format: Format, pages: number): Uint8Array {
	return format === "pptx"
		? buildPptx({
				slides: Array.from({ length: pages }, (_, k) => ({
					shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(k)}`)))
				}))
			})
		: odpBytes({
				body: Array.from(
					{ length: pages },
					(_, k) =>
						`<draw:page draw:name="P${String(k)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>S${String(k)}</text:p></draw:text-box></draw:frame></draw:page>`
				).join("")
			})
}

// A save whose upload runs `during` before reading the file (the writer waits on its pulls) or after it, then the
// commit. Returns the save's answer and the commit's.
async function saveWith(d: Drive, when: When, during: () => Promise<void>) {
	const { port1, port2 } = new MessageChannel()
	let started: Promise<void> = Promise.resolve()
	const uploading = savePortAnnounced(port2 as unknown as SavePortEnd).then(async write => {
		if (!write) return undefined
		if (when === "while it is written") await during()
		// Its reads still running when the upload lands: they wait for the commit, then read the file the save made.
		if (when === "as its upload begins, finishing after the commit") started = during()

		return d.drive.upload(port2, undefined)
	})
	const result = await saveSession(d.context, { reason: "user", port: port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)
	const uuid = result.kind === "written" ? await uploading : undefined

	port1.close()
	port2.close()

	// Posted before the commit, as the page posts an edit while the upload's answer is on its way (the edit may wait
	// for the commit).
	const edited = when === "after its upload, before its commit" ? during() : Promise.resolve()

	if (result.kind !== "written" || uuid === undefined) {
		await edited
		await started

		return { result, committed: undefined, bytes: undefined }
	}

	const bytes = d.drive.files.get(uuid)
	const committed = await commitSavedSession(
		d.context,
		{
			file: { uuid, name: "deck" },
			port: { uuid, postMessage: () => undefined, close: () => undefined } as never,
			size: bytes?.length ?? 0,
			revision: result.revision
		},
		SAVE_DEPENDENCIES
	)

	await edited
	await started

	return { result, committed, bytes }
}

// Each slide as hidden mark, its first shape's x and text.
async function summaryOf(d: Drive): Promise<string> {
	const out: string[] = []

	for (const slide of d.session.deck.slides) {
		await review(d.context, slide)

		const node = d.session.deck.nodes.get(slide) as SlideNode
		const shape = node.shapes[0]
		const text = shape?.text?.paragraphs.map(paragraph => paragraph.runs.map(run => ("text" in run ? run.text : "")).join("")).join("/")

		out.push(`${node.hidden === true ? "hidden " : ""}${String((shape?.xfrm as Xfrm | undefined)?.x ?? "-")} ${text ?? ""}`)
	}

	return out.join(", ")
}

async function nudge(d: Drive, slide: SlideRef): Promise<void> {
	const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes[0] as ShapeNode
	const box = shape.xfrm as Xfrm

	expect(
		(await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: shape.id }, xfrm: { ...box, x: box.x + 12_700 } })).ok
	).toBe(true)
}

const EDITS: Record<string, (d: Drive, slides: readonly SlideRef[]) => DeckOp> = {
	delete: (_, slides) => ({ family: "slide", kind: "delete", slides: [slides[0] as SlideRef] }),
	duplicate: (_, slides) => ({ family: "slide", kind: "duplicate", slide: slides[0] as SlideRef }),
	add: d => ({ family: "slide", kind: "add", at: 1, layout: d.session.deck.layouts[0] as SlideRef }),
	move: (_, slides) => ({ family: "slide", kind: "move", slides: [slides[0] as SlideRef], to: 2 }),
	hide: (_, slides) => ({ family: "slide", kind: "hide", slides: [slides[1] as SlideRef], hidden: true })
}

// The session's file read over a slow link (each read a few ms, as a range port's): an op's reads outlast the upload.
function slowReads(d: Drive): void {
	const inner = d.session.package.source
	const read: typeof inner.read = async (offset, length) => {
		await new Promise(resolve => setTimeout(resolve, 40))

		return inner.read(offset, length)
	}

	;(d.session as { package: typeof d.session.package }).package = {
		...d.session.package,
		source: rebasableSource({ size: inner.size, read })
	}
}

describe("a slide edit made while a save is under way", () => {
	for (const format of ["odp", "pptx"] as const)
		for (const when of [
			"while it is written",
			"as its upload begins, finishing after the commit",
			"after its upload, before its commit"
		] as const)
			for (const [what, edit] of Object.entries(EDITS))
				it(`${format}: ${what} ${when}: the save lands, the edit stays, the next save writes it`, async () => {
					const d = await driveSession(deckOf(format, 3), format)
					const slides = [...d.session.deck.slides]

					const straddles = when === "as its upload begins, finishing after the commit"

					// Unread slides, so the edit reads them (over the slow link) when it comes.
					for (const slide of straddles ? slides.slice(0, 1) : slides) await review(d.context, slide)
					await nudge(d, slides[0] as SlideRef)

					if (straddles) slowReads(d)

					let applied = false
					const {
						result,
						committed,
						bytes: first
					} = await saveWith(d, when, async () => {
						applied = (await d.command(edit(d, slides))).ok
					})

					expect(applied).toBe(true)
					expect(result.kind).toBe("written")
					// Committed (an edit posted before the commit is applied once it is in: the next save's).
					expect(committed).toBeDefined()

					const model = await summaryOf(d)
					const next = await d.save()

					expect(next.result.kind).toBe("written")
					expect(await summaryOf(await driveSession(next.bytes as Uint8Array, format))).toBe(model)
					expect(await summaryOf(d)).toBe(model)
					expect((await d.save()).result.kind).toBe("unchanged")

					// Undone, the edit's slides come back as the first save wrote them.
					const before = await summaryOf(await driveSession(first as Uint8Array, format))

					expect((await d.undo()).ok).toBe(true)

					const undone = await d.save()

					expect(undone.result.kind).toBe("written")
					expect(await summaryOf(await driveSession(undone.bytes as Uint8Array, format))).toBe(before)
				})
})

describe("an undo made while a save is under way", () => {
	for (const format of ["odp", "pptx"] as const)
		for (const when of [
			"while it is written",
			"as its upload begins, finishing after the commit",
			"after its upload, before its commit"
		] as const)
			it(`${format}: undoing the slide delete the save writes, ${when}: the slide comes back and the next save writes it`, async () => {
				const d = await driveSession(deckOf(format, 3), format)
				const slides = [...d.session.deck.slides]

				for (const slide of slides) await review(d.context, slide)

				// The save writes the delete; the undo takes it back meanwhile.
				expect((await d.command({ family: "slide", kind: "delete", slides: [slides[1] as SlideRef] })).ok).toBe(true)

				let undone = false
				const { result } = await saveWith(d, when, async () => {
					undone = (await d.undo()).ok
				})

				expect(undone).toBe(true)
				expect(result.kind).toBe("written")
				expect(d.session.deck.slides.length).toBe(3)

				const model = await summaryOf(d)
				const next = await d.save()

				expect(next.result.kind).toBe("written")
				expect(await summaryOf(await driveSession(next.bytes as Uint8Array, format))).toBe(model)
			})
})
