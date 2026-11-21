import { describe, it, expect } from "vitest"
import { compareParticipantsByName, contactDisplayName } from "@filen/shared"

describe("contactDisplayName", () => {
	it("returns the nickname when it is set and non-empty", () => {
		expect(contactDisplayName({ email: "alice@filen.io", nickName: "Alice" })).toBe("Alice")
	})

	it("falls back to the email when nickName is an empty string", () => {
		expect(contactDisplayName({ email: "alice@filen.io", nickName: "" })).toBe("alice@filen.io")
	})

	it("falls back to the email when nickName is absent", () => {
		expect(contactDisplayName({ email: "alice@filen.io" })).toBe("alice@filen.io")
	})
})

describe("compareParticipantsByName", () => {
	it("orders by natural display name, then user id", () => {
		const people = [
			{ userId: 4n, email: "d@filen.io", nickName: "Sam" },
			{ userId: 1n, email: "user 10@filen.io" },
			{ userId: 3n, email: "c@filen.io", nickName: "sam" },
			{ userId: 2n, email: "User 2@filen.io" }
		]
		const expected = [3n, 4n, 2n, 1n]

		expect(people.toSorted(compareParticipantsByName).map(person => person.userId)).toEqual(expected)
		expect(
			people
				.toReversed()
				.toSorted(compareParticipantsByName)
				.map(person => person.userId)
		).toEqual(expected)
	})
})
