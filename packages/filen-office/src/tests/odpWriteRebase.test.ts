import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { rebaseOdpDeck } from "../core/odp/write/rebase"
import { plainText } from "./odpFixtures"
import { changes, odpApplier, odpDeck, openOdpDeck, saveDeck, shapeNamed } from "./odpWriteFixtures"

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
})
