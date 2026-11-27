import { describe, expect, it } from "vitest"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS } from "@filen/shared"
import {
	highlightRanges,
	messageMatchesNeedle,
	newestMatchInPage,
	oldestTimestamp,
	stepThreadMatch,
	threadSearchMatches,
	threadSearchNeedle
} from "@/features/chats/components/thread/threadSearch.logic"
import { mockChatMessage, mockUndecryptableChatMessage } from "@/tests/fixtures/sdk"
import { testUuid } from "@/tests/support/uuid"

function message(label: string, text: string | undefined, sentTimestamp: bigint, senderId = 2) {
	const fields = { uuid: testUuid(label), senderId, senderEmail: `u${String(senderId)}@x.io`, sentTimestamp }

	return text === undefined ? mockUndecryptableChatMessage(fields) : mockChatMessage({ ...fields, message: text })
}

describe("threadSearchNeedle / messageMatchesNeedle", () => {
	it("ignores case and outer whitespace, and an empty needle matches nothing", () => {
		expect(threadSearchNeedle("  Hello ")).toBe("hello")
		expect(messageMatchesNeedle("Say HELLO there", "hello")).toBe(true)
		expect(messageMatchesNeedle("nothing", "hello")).toBe(false)
		expect(messageMatchesNeedle("anything", "")).toBe(false)
		expect(messageMatchesNeedle(undefined, "hello")).toBe(false)
	})
})

describe("threadSearchMatches", () => {
	const messages = [
		message("a", "lunch at noon", 1n),
		message("b", "no", 2n),
		message("c", "Lunch again?", 3n),
		message("d", undefined, 4n)
	]

	it("lists the matching messages newest first, skipping undecryptable ones", () => {
		expect(threadSearchMatches(messages, "lunch", EMPTY_BLOCKED_USERS, new Set())).toEqual([testUuid("c"), testUuid("a")])
	})

	it("returns nothing for an empty needle", () => {
		expect(threadSearchMatches(messages, "", EMPTY_BLOCKED_USERS, new Set())).toEqual([])
	})

	it("leaves out a blocked sender's hidden messages until revealed", () => {
		const blocked = deriveBlockedUsers([{ userId: 2n, email: "u2@x.io" }])

		expect(threadSearchMatches(messages, "lunch", blocked, new Set())).toEqual([])
		expect(threadSearchMatches(messages, "lunch", blocked, new Set([testUuid("a")]))).toEqual([testUuid("a")])
	})
})

describe("stepThreadMatch", () => {
	const matches = ["n", "m", "o"]

	it("steps older and newer, clamped at both ends", () => {
		expect(stepThreadMatch(matches, "n", 1)).toBe("m")
		expect(stepThreadMatch(matches, "o", 1)).toBe("o")
		expect(stepThreadMatch(matches, "m", -1)).toBe("n")
		expect(stepThreadMatch(matches, "n", -1)).toBe("n")
	})

	it("starts from the newest without a current match", () => {
		expect(stepThreadMatch(matches, null, 1)).toBe("n")
		expect(stepThreadMatch(matches, "gone", -1)).toBe("n")
		expect(stepThreadMatch([], null, 1)).toBeNull()
	})
})

describe("highlightRanges", () => {
	it("finds every occurrence, case-insensitively", () => {
		expect(highlightRanges("Ab ab AB", "ab")).toEqual([
			{ start: 0, end: 2 },
			{ start: 3, end: 5 },
			{ start: 6, end: 8 }
		])
	})

	it("marks nothing when lower-casing changes the text's length", () => {
		expect(highlightRanges("İstanbul", "stan")).toEqual([])
	})
})

describe("older pages", () => {
	it("takes the next cursor from a page's oldest message", () => {
		expect(oldestTimestamp([message("a", "x", 5n), message("b", "y", 3n), message("c", "z", 9n)])).toBe(3n)
		expect(oldestTimestamp([])).toBeUndefined()
	})

	it("picks the newest match of a page", () => {
		const page = [message("a", "lunch", 5n), message("b", "lunch", 7n), message("c", "other", 9n)]

		expect(newestMatchInPage(page, "lunch", EMPTY_BLOCKED_USERS)?.uuid).toBe(testUuid("b"))
		expect(newestMatchInPage(page, "dinner", EMPTY_BLOCKED_USERS)).toBeUndefined()
	})
})
