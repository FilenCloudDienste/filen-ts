import { describe, expect, it } from "vitest"
import type { ChatMessage, ChatParticipant } from "@filen/sdk-rs"
import {
	MAX_CHAT_MESSAGE_LENGTH,
	canSend,
	isAttachDisabled,
	isOverLimit,
	remainingChars,
	shouldShowCounter,
	enterIntent,
	shouldEditLastOnArrowUp,
	buildReplyPartial,
	activeMentionQuery,
	activeEmojiQuery,
	filterMentionParticipants,
	filterEmojiSuggestions,
	applyMention,
	applyEmoji,
	lastEditableOwnMessage,
	appendAttachmentUrl
} from "@/features/chats/lib/composer.logic"
import { emojiForShortcode, customEmojiImageForShortcode } from "@/features/chats/lib/emoji"

// Pure composer core — no React/store/IO. Uuid-shaped fields are the SDK's branded UuidStr; literal
// strings with 3+ dashes satisfy that template type directly.

function participant(userId: bigint, email: string, nickName?: string): ChatParticipant {
	return {
		userId,
		email,
		nickName,
		permissionsAdd: false,
		added: 0n,
		appearOffline: false,
		lastActive: 0n
	}
}

function message(uuid: string, senderId: number, body: string | undefined, sentTimestamp: bigint): ChatMessage {
	// exactOptionalPropertyTypes: an undecryptable message OMITS the `message` key, never sets it undefined.
	const base = {
		uuid: uuid as ChatMessage["uuid"],
		chat: "chat-a-a-a" as ChatMessage["chat"],
		senderId,
		senderEmail: "peer@filen.io",
		senderNickName: "Peer",
		embedDisabled: false,
		edited: false,
		editedTimestamp: 0n,
		sentTimestamp
	} satisfies Omit<ChatMessage, "message" | "senderAvatar" | "replyTo">

	return body === undefined ? base : { ...base, message: body }
}

describe("enterIntent", () => {
	it("Enter sends, Shift+Enter is a newline, other keys are null", () => {
		expect(enterIntent({ key: "Enter", shiftKey: false })).toBe("send")
		expect(enterIntent({ key: "Enter", shiftKey: true })).toBe("newline")
		expect(enterIntent({ key: "a", shiftKey: false })).toBeNull()
		expect(enterIntent({ key: "ArrowUp", shiftKey: false })).toBeNull()
	})
})

describe("character-limit gating", () => {
	it("blocks an over-limit body and reports the remaining count", () => {
		const atLimit = "x".repeat(MAX_CHAT_MESSAGE_LENGTH)
		const overLimit = "x".repeat(MAX_CHAT_MESSAGE_LENGTH + 1)

		expect(isOverLimit(atLimit)).toBe(false)
		expect(isOverLimit(overLimit)).toBe(true)
		expect(remainingChars(atLimit)).toBe(0)
		expect(remainingChars(overLimit)).toBe(-1)
		expect(canSend(atLimit)).toBe(true)
		expect(canSend(overLimit)).toBe(false)
	})

	it("does not allow sending a blank / whitespace-only body", () => {
		expect(canSend("")).toBe(false)
		expect(canSend("   \n\t ")).toBe(false)
		expect(canSend("hi")).toBe(true)
	})

	it("only surfaces the counter within the threshold of the cap", () => {
		expect(shouldShowCounter("short")).toBe(false)
		expect(shouldShowCounter("x".repeat(MAX_CHAT_MESSAGE_LENGTH - 10))).toBe(true)
	})

	// Send and attach deliberately DISAGREE on offline behavior — send queues through the
	// durable outbox and must never gate on connectivity; attach starts a network op right now and
	// must. Both assertions live together so a future edit that accidentally aligns them regresses
	// visibly here instead of silently in composer.tsx.
	it("canSend stays true offline — the outbox is the whole point of an offline send", () => {
		expect(canSend("hi")).toBe(true)
	})

	it("isAttachDisabled disables the attach menu while offline", () => {
		expect(isAttachDisabled(0, false, true)).toBe(true)
		expect(isAttachDisabled(0, true, true)).toBe(false)
	})

	it("isAttachDisabled disables the attach menu while an upload is already in flight, online or not", () => {
		expect(isAttachDisabled(1, true, true)).toBe(true)
		expect(isAttachDisabled(1, false, true)).toBe(true)
	})

	it("isAttachDisabled pre-gates a non-Pro account — even idle and online", () => {
		expect(isAttachDisabled(0, true, false)).toBe(true)
	})

	it("isAttachDisabled is enabled only when idle, online, AND Pro", () => {
		expect(isAttachDisabled(0, true, true)).toBe(false)
	})
})

describe("shouldEditLastOnArrowUp", () => {
	it("only fires on a truly empty composer", () => {
		expect(shouldEditLastOnArrowUp("")).toBe(true)
		expect(shouldEditLastOnArrowUp(" ")).toBe(false)
		expect(shouldEditLastOnArrowUp("draft")).toBe(false)
	})
})

describe("activeMentionQuery", () => {
	it("activates on an @ at the start of the input", () => {
		expect(activeMentionQuery("@ab", 3)).toEqual({ start: 0, query: "ab" })
	})

	it("activates on an @ after whitespace", () => {
		expect(activeMentionQuery("hi @bo", 6)).toEqual({ start: 3, query: "bo" })
	})

	it("does NOT activate on the @ inside an email (glued to a non-space)", () => {
		expect(activeMentionQuery("mail@host", 9)).toBeNull()
	})

	it("closes once the token contains a space", () => {
		expect(activeMentionQuery("@bo done", 8)).toBeNull()
	})

	it("is null with no @ before the caret", () => {
		expect(activeMentionQuery("plain text", 5)).toBeNull()
	})
})

describe("filterMentionParticipants", () => {
	const alice = participant(1n, "alice@filen.io", "Alice")
	const bob = participant(2n, "bob@filen.io", "Bob")
	const me = participant(7n, "me@filen.io", "Me")

	it("excludes self and empty query lists everyone else sorted by name", () => {
		expect(filterMentionParticipants([me, bob, alice], "", 7n)).toEqual([alice, bob])
	})

	it("matches on display name or email, case-insensitively", () => {
		expect(filterMentionParticipants([alice, bob], "ali", undefined)).toEqual([alice])
		expect(filterMentionParticipants([alice, bob], "BOB@", undefined)).toEqual([bob])
	})
})

describe("applyMention", () => {
	it("replaces the @token with @<email> and a trailing space, caret after it", () => {
		const result = applyMention("hi @al", { start: 3, query: "al" }, participant(1n, "alice@filen.io", "Alice"))

		expect(result.value).toBe("hi @alice@filen.io ")
		expect(result.caret).toBe(result.value.length)
	})

	it("keeps trailing text after the caret", () => {
		const result = applyMention("@al rest", { start: 0, query: "al" }, participant(1n, "alice@filen.io"))

		expect(result.value).toBe("@alice@filen.io  rest")
	})
})

describe("activeEmojiQuery + emoji application", () => {
	it("requires the minimum token length before activating", () => {
		expect(activeEmojiQuery(":s", 2)).toBeNull()
		expect(activeEmojiQuery(":sm", 3)).toEqual({ start: 0, query: "sm" })
	})

	it("does not activate on a glued colon (e.g. a url scheme)", () => {
		expect(activeEmojiQuery("http:smi", 8)).toBeNull()
	})

	it("filters known shortcodes and inserts the unicode glyph", () => {
		const items = filterEmojiSuggestions("joy", 8)

		expect(items.length).toBeGreaterThan(0)
		expect(items[0]?.name).toBe("joy")

		const result = applyEmoji("say :joy", { start: 4, query: "joy" }, "😂")

		expect(result.value).toBe("say 😂 ")
		expect(result.caret).toBe(result.value.length)
	})

	it("resolves a shortcode to unicode and leaves an unknown one undefined", () => {
		expect(emojiForShortcode("joy")).toBe("😂")
		expect(emojiForShortcode("definitely_not_a_real_emoji")).toBeUndefined()
	})

	// "smile" exists in both the standard table and the custom CDN pack — mobile-parity precedence means
	// the custom pack wins, so the `:` autocomplete surfaces it as a "custom" suggestion, not "standard".
	it("surfaces a colliding shortcode as its custom-pack suggestion, not the standard glyph", () => {
		const items = filterEmojiSuggestions("smile", 8)
		const smileMatches = items.filter(item => item.name === "smile")

		expect(smileMatches).toHaveLength(1)
		expect(smileMatches[0]?.kind).toBe("custom")
	})

	it("sources the custom emoji pack into the suggestion list alongside standard shortcodes", () => {
		const items = filterEmojiSuggestions("kekw", 8)

		// The full pack has several "kekw*" prefix siblings (kekwaddle, kekwait, ...) — exact-match "kekw"
		// still ranks first (prefix-tier alphabetical), which is what selectEmoji actually keys off.
		expect(items.length).toBeGreaterThan(0)
		expect(items[0]).toEqual({ kind: "custom", name: "kekw", imageUrl: expect.any(String) as string })
		expect(items.every(item => item.kind === "custom")).toBe(true)
	})

	it("completes a custom-pack suggestion to its literal shortcode text, not a glyph", () => {
		// composer.tsx's selectEmoji: a "custom" suggestion has no unicode glyph, so it completes to
		// `:name:` — the same text messageContent.tsx resolves back to the bundled image.
		const result = applyEmoji("say :kekw", { start: 4, query: "kekw" }, ":kekw:")

		expect(result.value).toBe("say :kekw: ")
	})

	it("resolves a custom-pack shortcode to its image url and leaves an unknown one undefined", () => {
		expect(customEmojiImageForShortcode("kekw")).toEqual(expect.any(String))
		expect(customEmojiImageForShortcode("definitely_not_a_real_custom_emoji")).toBeUndefined()
	})
})

describe("buildReplyPartial", () => {
	it("denormalizes the reply target's uuid + sender fields + body", () => {
		const partial = buildReplyPartial(message("msg-1-1-1", 2, "hello there", 100n))

		expect(partial.uuid).toBe("msg-1-1-1")
		expect(partial.senderId).toBe(2)
		expect(partial.senderEmail).toBe("peer@filen.io")
		expect(partial.message).toBe("hello there")
	})

	it("omits the body key for an undecryptable target (exactOptionalPropertyTypes)", () => {
		const partial = buildReplyPartial(message("msg-2-2-2", 2, undefined, 100n))

		expect("message" in partial).toBe(false)
	})
})

describe("lastEditableOwnMessage", () => {
	it("returns the newest own decryptable message", () => {
		const messages = [message("a-a-a-a", 7, "first", 100n), message("b-b-b-b", 2, "peer", 200n), message("c-c-c-c", 7, "second", 300n)]

		expect(lastEditableOwnMessage(messages, 7n)?.uuid).toBe("c-c-c-c")
	})

	it("skips uncommitted (excluded) own entries so ArrowUp never edits a pending send", () => {
		const messages = [message("committed-a-a", 7, "sent", 100n), message("pending-b-b-b", 7, "queued", 200n)]

		expect(lastEditableOwnMessage(messages, 7n, new Set(["pending-b-b-b"]))?.uuid).toBe("committed-a-a")
	})

	it("skips others' and undecryptable messages, and is undefined without a user id", () => {
		const messages = [message("a-a-a-a", 2, "peer", 100n), message("b-b-b-b", 7, undefined, 200n)]

		expect(lastEditableOwnMessage(messages, 7n)).toBeUndefined()
		expect(lastEditableOwnMessage(messages, undefined)).toBeUndefined()
	})
})

describe("appendAttachmentUrl", () => {
	it("becomes just the url on a blank draft", () => {
		expect(appendAttachmentUrl("", "https://app.filen.io/#/d/uuid%23key")).toBe("https://app.filen.io/#/d/uuid%23key")
	})

	it("appends with a single separating space on a non-blank draft", () => {
		expect(appendAttachmentUrl("check this out", "https://app.filen.io/#/d/uuid%23key")).toBe(
			"check this out https://app.filen.io/#/d/uuid%23key"
		)
	})

	it("trims trailing whitespace before appending, never doubling the separator", () => {
		expect(appendAttachmentUrl("check this out   ", "https://x.example.com/a")).toBe("check this out https://x.example.com/a")
	})

	it("a whitespace-only draft collapses to just the url (mirrors the blank case)", () => {
		expect(appendAttachmentUrl("   ", "https://x.example.com/a")).toBe("https://x.example.com/a")
	})

	it("stacks a second attachment after the first (sequential appends both space-separated)", () => {
		const once = appendAttachmentUrl("", "https://x.example.com/a")
		const twice = appendAttachmentUrl(once, "https://x.example.com/b")

		expect(twice).toBe("https://x.example.com/a https://x.example.com/b")
	})
})
