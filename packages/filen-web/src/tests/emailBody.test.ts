// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { sanitizeBody } from "@/features/preview/lib/emailBody"

// The parts a message's HTML shows in place, by index; none when the sanitized HTML is too large to show.

describe("sanitizeBody", () => {
	it("names the part each resolved picture shows", () => {
		const { shown } = sanitizeBody(
			'<img src="cid:a"><img src="cid:a"><img src="cid:missing">',
			new Map([["a", { url: "blob:x/1", part: 2 }]])
		)

		expect([...shown]).toEqual([2])
	})

	it("shows no part in place when the sanitized HTML is past its cap, so every part stays listed", () => {
		const url = `blob:x/${"u".repeat(10_000)}`
		const { sanitized, shown } = sanitizeBody('<img src="cid:a">'.repeat(1000), new Map([["a", { url, part: 0 }]]))

		expect(sanitized.tooLarge).toBe(true)
		expect(shown.size).toBe(0)
	})
})
