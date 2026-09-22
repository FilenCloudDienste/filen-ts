import { describe, it, expect } from "vitest"
import { resolveChatParticipantsDisplayName } from "@filen/shared"

describe("resolveChatParticipantsDisplayName", () => {
	it("returns the solo fallback when there are no other participants", () => {
		expect(resolveChatParticipantsDisplayName([], "Just you")).toBe("Just you")
	})

	it("1:1 — returns the other participant's nickname when present", () => {
		expect(resolveChatParticipantsDisplayName([{ email: "a@x.com", nickName: "Ann" }], "Just you")).toBe("Ann")
	})

	it("1:1 — falls back to email when the other participant has no nickname", () => {
		expect(resolveChatParticipantsDisplayName([{ email: "a@x.com" }], "Just you")).toBe("a@x.com")
	})

	it("1:1 — treats an empty-string nickname the same as absent", () => {
		expect(resolveChatParticipantsDisplayName([{ email: "a@x.com", nickName: "" }], "Just you")).toBe("a@x.com")
	})

	it("multi — joins every other participant's display name with a comma", () => {
		expect(
			resolveChatParticipantsDisplayName(
				[
					{ email: "a@x.com", nickName: "Ann" },
					{ email: "b@x.com" }
				],
				"Just you"
			)
		).toBe("Ann, b@x.com")
	})

	it("multi — sorts the joined names regardless of input order", () => {
		expect(
			resolveChatParticipantsDisplayName(
				[{ email: "zeta@x.com" }, { email: "unused@x.com", nickName: "Alpha" }],
				"Just you"
			)
		).toBe("Alpha, zeta@x.com")
	})
})
