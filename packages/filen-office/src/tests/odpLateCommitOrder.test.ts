import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { latestSnapshotRevision } from "../core/odp/write/save"
import { review } from "../dom/presentation/engine/review"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"

// A range-backed ODP deck whose written save the page commits late, a slide deleted meanwhile and a later save made
// before that commit: each commit rebases onto its own save's file against the slide order its own snapshot wrote, so
// the late commit lands and the session saves on.

type Drive = Awaited<ReturnType<typeof driveSession>>

function deckOf(pages: number): Uint8Array {
	return odpBytes({
		body: Array.from(
			{ length: pages },
			(_, k) =>
				`<draw:page draw:name="P${String(k)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>S${String(k)}</text:p></draw:text-box></draw:frame></draw:page>`
		).join("")
	})
}

async function nudge(d: Drive, slide: SlideRef): Promise<void> {
	await review(d.context, slide)

	const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes[0] as ShapeNode
	const box = shape.xfrm as Xfrm

	expect(
		(await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: shape.id }, xfrm: { ...box, x: box.x + 12_700 } })).ok
	).toBe(true)
}

async function pagesOf(bytes: Uint8Array | undefined): Promise<number> {
	if (bytes === undefined) throw new Error("no saved file")

	return (await driveSession(bytes, "odp")).session.deck.slides.length
}

describe("an ODP save committed late, a slide deleted meanwhile and a later save in between", () => {
	it("lands the late commit against its own snapshot's slides, and the session saves the deck as it is", async () => {
		const d = await driveSession(deckOf(4), "odp", [], { commitWaitMs: 50, inMemoryLimit: 0 })

		for (const slide of d.session.deck.slides) await review(d.context, slide)
		await nudge(d, d.session.deck.slides[0] as SlideRef)

		const first = await d.begin()

		expect(first.result.kind).toBe("written")

		const deleted = d.command({ family: "slide", kind: "delete", slides: [d.session.deck.slides[1] as SlideRef] })

		expect((await deleted).ok).toBe(true)

		// A later save, past the wait for the first one's commit: its snapshot is of three slides.
		const second = await d.begin()

		await second.commit()
		await expect(first.commit()).resolves.not.toThrow()

		const third = await d.save()

		expect(d.session.deck.slides.length).toBe(3)
		expect(third.result.kind).toBe("written")
		expect(await pagesOf(third.bytes)).toBe(3)
		expect((await d.save()).result.kind).toBe("unchanged")
		// Every order a commit took is let go of: none is kept for a file that is no longer to come.
		expect(latestSnapshotRevision(d.session.deck)).toBeUndefined()
	})
})
