import { describe, expect, it } from "vitest"
import { EXTRA_SUFFIXES, parseExtraName } from "@filen/shared/videos"

describe("parseExtraName", () => {
	it("matches every suffix word the type map knows", () => {
		for (const [word, type] of EXTRA_SUFFIXES) {
			expect(parseExtraName(`Movie - ${word}`), word).toEqual({ type, owner: "Movie" })
			expect(parseExtraName(`Movie-${word.toUpperCase()} 2`), word).toEqual({ type, owner: "Movie" })
		}
	})

	it("reads deletedscene as its own word, not deleted plus a tail", () => {
		expect(parseExtraName("Movie - deletedscene")).toEqual({ type: "deletedScene", owner: "Movie" })
		expect(parseExtraName("deletedscene2")).toEqual({ type: "deletedScene", owner: "" })
	})

	it("keeps common words out of whole stems", () => {
		expect(parseExtraName("trailer")).toEqual({ type: "trailer", owner: "" })
		expect(parseExtraName("clip")).toBeNull()
		expect(parseExtraName("short")).toBeNull()
	})
})
