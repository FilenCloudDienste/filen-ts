import { describe, expect, it } from "vitest"
import { textOfSlides } from "../dom/presentation/engine/find"
import { editDeck, editHarness } from "./presentationEditFixtures"

// The "text" request a reader (the assistant) makes: slides' shape text and speaker notes, read as find reads them,
// cut at the characters asked for.

describe("the slides' text", () => {
	it("reads each slide's shapes a paragraph a line, with its notes, from and to deck indices", async () => {
		const h = await editHarness(editDeck())

		expect(await textOfSlides(h.context, 0, 2, 1000)).toEqual({
			slides: [
				{ index: 0, text: "Title\nB", notes: "Notes one" },
				{ index: 1, text: "Second\nText", notes: "" },
				{ index: 2, text: "Third", notes: "" }
			],
			truncated: false
		})
		expect(await textOfSlides(h.context, 3, 99, 1000)).toEqual({ slides: [{ index: 3, text: "Fourth", notes: "" }], truncated: false })
		h.close()
	})

	it("stops at the characters asked for, saying so", async () => {
		const h = await editHarness(editDeck())

		expect(await textOfSlides(h.context, 0, 3, 9)).toEqual({ slides: [{ index: 0, text: "Title\nB", notes: "No" }], truncated: true })
		expect(await textOfSlides(h.context, 0, 3, 3)).toEqual({ slides: [{ index: 0, text: "Tit", notes: "" }], truncated: true })
		h.close()
	})
})
