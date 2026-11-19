import { describe, expect, it, vi } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { rebaseOdpDeck } from "../core/odp/write/rebase"
import { visitSources } from "../core/pptx/sourcePath"
import { odpSourceReading } from "../core/odp/write/session"
import { OdpWriteSource, odpWriteSource } from "../core/odp/write/source"
import { applyOp, type ApplyContext } from "../core/presentation/edit/apply"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type SlideNode, type SlideRef, type SourceRef } from "../core/presentation/model"
import { odpBytes, plainText } from "./odpFixtures"
import { changes, odpApplier, odpDeck, openOdpDeck, saveDeck, shapeNamed, type OpenedOdp } from "./odpWriteFixtures"

// The deck moved onto the file a save wrote.
async function rebased(opened: OpenedOdp, bytes: Uint8Array): Promise<OpenedOdp> {
	const parts = await rebaseOdpDeck(opened.deck, opened.parts, bytesSource(bytes))

	if ("kind" in parts) throw new Error(`${parts.reason} ${parts.detail ?? ""}`)

	return { bytes, deck: opened.deck, parts }
}

function apply(opened: OpenedOdp, context: ApplyContext, op: DeckOp): void {
	expect(applyOp(opened.deck, op, context).kind).toBe("applied")
}

// Every source ref under a slide and its notes, in visiting order, without its epoch.
function refsOf(deck: OpenedOdp["deck"], node: SlideNode): Omit<Extract<SourceRef, { format: "odp" }>, "epoch">[] {
	const out: Omit<Extract<SourceRef, { format: "odp" }>, "epoch">[] = []
	const collect = (src: SourceRef): SourceRef => {
		if (src.format === "odp") out.push({ format: src.format, part: src.part, fragment: src.fragment, node: src.node })

		return src
	}
	const notes = node.notes === undefined ? undefined : deck.nodes.get(node.notes)

	visitSources(node, collect)

	if (notes !== undefined) visitSources(notes, collect)

	return out
}

// A move of a slide's shape to x.
function moved(opened: OpenedOdp, slide: SlideRef, name: string, x: number): DeckOp {
	const node = opened.deck.nodes.get(slide)

	if (node === undefined) throw new Error("no slide")

	const shape = shapeNamed(node, name)

	return {
		family: "shape",
		kind: "setXfrm",
		target: { slide, id: shape.id },
		xfrm: { ...(shape.xfrm as NonNullable<typeof shape.xfrm>), x }
	}
}

// A deck moved onto its saved file: the reader takes the session's deck over, its refs read their pages again.

describe("ODP rebase", () => {
	it("rebinds the session's slides into the saved file after a delete, a duplicate and an edit, and saves on from there", async () => {
		const opened = await openOdpDeck(odpDeck())
		const apply = odpApplier(opened)
		const [intro, middle, end] = opened.deck.slides

		if (intro === undefined || middle === undefined || end === undefined) throw new Error("no slides")

		apply({ family: "slide", kind: "delete", slides: [end] })
		apply({ family: "slide", kind: "duplicate", slide: middle })

		const box = shapeNamed(opened.deck.nodes.get(intro) ?? opened.deck.nodes.values().next().value ?? (undefined as never), "Box")

		apply({
			family: "shape",
			kind: "setXfrm",
			target: { slide: intro, id: box.id },
			xfrm: { ...(box.xfrm as NonNullable<typeof box.xfrm>), x: 0 }
		})

		const saved = await saveDeck(opened, changes("slideList", "customShows"))

		expect(saved.outcome.kind).toBe("written")

		const parts = await rebaseOdpDeck(opened.deck, opened.parts, bytesSource(saved.bytes))

		if ("kind" in parts) throw new Error(`${parts.reason} ${parts.detail ?? ""}`)

		expect(parts.epoch).toBe(1)
		expect(parts.pageRefs()).toEqual(opened.deck.slides)

		const rebased = { bytes: saved.bytes, deck: opened.deck, parts }

		// Nothing changed since the save: nothing to write. Then an edit on the duplicate writes from the new file.
		for (const node of opened.deck.nodes.values()) node.revision++

		expect((await saveDeck(rebased)).outcome.kind).toBe("unchanged")

		const copy = opened.deck.nodes.get(opened.deck.slides[2] ?? intro)

		if (copy === undefined) throw new Error("no copy")

		shapeNamed(copy, "Title2").name = "Copy title"

		const again = await saveDeck(rebased)

		expect(again.outcome.kind).toBe("written")

		const reopened = await openOdpDeck(again.bytes)
		const third = reopened.deck.nodes.get(reopened.deck.slides[2] ?? intro)

		expect(third === undefined ? "" : plainText(shapeNamed(third, "Copy title"))).toBe("Second page to the end")
		expect(reopened.deck.slides).toHaveLength(3)
	})

	it("reads again after a save only the pages edited since, and still writes an edit made while the file uploaded", async () => {
		const opened = await openOdpDeck(odpDeck())
		const [intro, middle, end] = opened.deck.slides

		if (intro === undefined || middle === undefined || end === undefined) throw new Error("no slides")

		const apply = odpApplier(opened)

		apply(moved(opened, intro, "Box", 0))
		apply(moved(opened, end, "Title3", 0))

		const first = await saveDeck(opened)

		expect(first.outcome.kind).toBe("written")

		// Made after the save's snapshot, before its file landed: the next save's.
		apply(moved(opened, intro, "Title", 0))

		const onto = await rebased(opened, first.bytes)
		const pristine = vi.spyOn(OdpWriteSource.prototype, "pristine")

		try {
			const second = await saveDeck(onto)

			expect(second.outcome.kind).toBe("written")
			expect(pristine.mock.calls.map(([ref]) => ref)).toEqual([intro])
			expect(shapeNamed((await openOdpDeck(second.bytes)).deck.nodes.get(intro) ?? (undefined as never), "Title").xfrm?.x).toBe(0)

			const again = await rebased(onto, second.bytes)

			pristine.mockClear()
			odpApplier(again)(moved(again, middle, "Title2", 0))

			const third = await saveDeck(again)

			expect(third.outcome.kind).toBe("written")
			expect(pristine.mock.calls.map(([ref]) => ref)).toEqual([middle])

			// Nothing edited since: nothing read, nothing written.
			const last = await rebased(again, third.bytes)

			pristine.mockClear()

			expect((await saveDeck(last)).outcome.kind).toBe("unchanged")
			expect(pristine).not.toHaveBeenCalled()
		} finally {
			pristine.mockRestore()
		}
	})

	it("writes a page an undo put back after a save and a rebase", async () => {
		const opened = await openOdpDeck(odpDeck())
		const [intro, , end] = opened.deck.slides

		if (intro === undefined || end === undefined) throw new Error("no slides")

		const apply = odpApplier(opened)

		apply(moved(opened, end, "Title3", 0))

		const first = await saveDeck(opened, changes("slideList", "customShows"))
		const onto = await rebased(opened, first.bytes)
		let next = 0x5000_0000
		const context = odpSourceReading(onto.deck, odpWriteSource(onto.parts), { next: () => slideRef(next++) })
		const deleted = applyOp(onto.deck, { family: "slide", kind: "delete", slides: [end] }, context)

		if (deleted.kind !== "applied") throw new Error("not deleted")

		const second = await saveDeck(onto, changes("slideList", "customShows"))

		expect(second.outcome.kind).toBe("written")

		const back = await rebased(onto, second.bytes)
		const undoContext = odpSourceReading(back.deck, odpWriteSource(back.parts), { next: () => slideRef(next++) })

		for (const op of deleted.inverse.ops) expect(applyOp(back.deck, op, undoContext).kind).toBe("applied")

		const third = await saveDeck(back, changes("slideList", "customShows"))

		expect(third.outcome.kind).toBe("written")

		const reopened = await openOdpDeck(third.bytes)

		expect(reopened.deck.slides).toHaveLength(3)
		expect(shapeNamed(reopened.deck.nodes.get(reopened.deck.slides[2] ?? intro) ?? (undefined as never), "Title3").xfrm?.x).toBe(0)
	})

	it("holds nothing for the source reads a table op's inverse only compares", async () => {
		const opened = await openOdpDeck(
			odpBytes({
				body:
					'<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="Table" svg:x="2cm" svg:y="4cm" svg:width="8cm" svg:height="2cm">' +
					'<table:table><table:table-column table:number-columns-repeated="2"/>' +
					"<table:table-row><table:table-cell><text:p>A1</text:p></table:table-cell><table:table-cell><text:p>B1</text:p></table:table-cell></table:table-row>" +
					"</table:table></draw:frame></draw:page>"
			})
		)
		const [one] = opened.deck.slides

		if (one === undefined) throw new Error("no slide")

		const source = odpWriteSource(opened.parts)
		const context = odpSourceReading(opened.deck, source, { next: () => slideRef(0x5000_0000) })
		const target = { slide: one, id: shapeNamed(opened.deck.nodes.get(one) ?? (undefined as never), "Table").id }
		const held = source.heldCount

		for (let row = 0; row < 8; row++)
			expect(applyOp(opened.deck, { family: "table", kind: "insertRows", target, at: 1, count: 1 }, context).kind).toBe("applied")

		expect(source.heldCount).toBe(held)
		expect((await saveDeck(opened)).outcome.kind).toBe("written")
	})

	it("writes a shape deleted, put back, deleted and put back again", async () => {
		const opened = await openOdpDeck(odpDeck())
		const [intro] = opened.deck.slides

		if (intro === undefined) throw new Error("no slides")

		const context = odpSourceReading(opened.deck, odpWriteSource(opened.parts), { next: () => slideRef(0x5000_0000) })
		const box = shapeNamed(opened.deck.nodes.get(intro) ?? (undefined as never), "Box")
		const remove: DeckOp = { family: "shape", kind: "delete", slide: intro, shapes: [box.id] }

		for (let round = 0; round < 2; round++) {
			const deleted = applyOp(opened.deck, remove, context)

			if (deleted.kind !== "applied") throw new Error("not deleted")

			for (const op of deleted.inverse.ops) expect(applyOp(opened.deck, op, context).kind).toBe("applied")
		}

		apply(opened, context, moved(opened, intro, "Box", 0))

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const read = shapeNamed((await openOdpDeck(saved.bytes)).deck.nodes.get(intro) ?? (undefined as never), "Box")

		expect(read.xfrm?.x).toBe(0)
		expect(plainText(read)).toBe("Box text")
	})

	it("moves the refs of a page the save copied without parsing it, onto what the saved file reads", async () => {
		const opened = await openOdpDeck(odpDeck())
		const [intro, middle, end] = opened.deck.slides

		if (intro === undefined || middle === undefined || end === undefined) throw new Error("no slides")

		// The first page grows, so the copied pages after it move in the file.
		odpApplier(opened)(moved(opened, intro, "Box", 0))
		const box = shapeNamed(opened.deck.nodes.get(intro) ?? (undefined as never), "Box")

		box.name = "A much longer name for the box"

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const fragment = vi.spyOn(OdpWriteSource.prototype, "fragment")
		let onto: OpenedOdp

		try {
			onto = await rebased(opened, saved.bytes)

			const written = new Set([opened.parts.content.pages[0]?.start, onto.parts.content.pages[0]?.start])

			expect(fragment.mock.calls.length).toBeGreaterThan(0)
			expect(fragment.mock.calls.every(([span]) => written.has(span.start))).toBe(true)
		} finally {
			fragment.mockRestore()
		}

		expect(onto.parts.content.pages[1]?.start).not.toBe(opened.parts.content.pages[1]?.start)

		// The refs of the copied pages are the ones a reading of the saved file gives them.
		const fresh = await openOdpDeck(saved.bytes)

		for (const [index, ref] of [middle, end].entries()) {
			const mine = opened.deck.nodes.get(ref)
			const read = fresh.deck.nodes.get(fresh.deck.slides[index + 1] ?? ref)

			if (mine === undefined || read === undefined) throw new Error("no slide")

			expect(refsOf(opened.deck, mine)).toEqual(refsOf(fresh.deck, read))
			expect(mine.src).toMatchObject({ epoch: 1 })
		}

		expect((await saveDeck(onto)).outcome.kind).toBe("unchanged")
	})
})
