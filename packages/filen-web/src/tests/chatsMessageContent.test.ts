// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import type { Chat } from "@filen/sdk-rs"
import "@/lib/i18n"
import { MessageContent } from "@/features/chats/components/thread/messageContent"
import { customEmojiImageForShortcode } from "@/features/chats/lib/emoji"

afterEach(() => {
	cleanup()
})

function mockChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: "aaaaaaaa-0000-0000-0000-000000000000",
		ownerId: 1n,
		key: "chat-key",
		participants: [],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

// The bundled custom-emoji pack subset renders as its image, and a message that's entirely emoji
// shortcodes renders "jumbo" (larger), mirroring mobile's emojiSize 32/20 split (regexed.logic.ts's
// isEmojiOnly, wired through messageContent.tsx).
describe("MessageContent — custom emoji pack + jumbo sizing", () => {
	it("renders a bundled custom-pack shortcode as its image, at the normal (non-jumbo) size", () => {
		const { container } = render(createElement(MessageContent, { chat: mockChat(), text: "check this out :kekw: nice" }))

		const img = container.querySelector("img")
		expect(img).not.toBeNull()
		expect(img?.getAttribute("src")).toBe(customEmojiImageForShortcode("kekw"))
		expect(img?.className).toContain("size-5")
		expect(img?.className).not.toContain("size-8")
	})

	it("renders a message that is ENTIRELY emoji shortcodes at jumbo size", () => {
		const { container } = render(createElement(MessageContent, { chat: mockChat(), text: ":kekw::pog:" }))

		const imgs = container.querySelectorAll("img")
		expect(imgs).toHaveLength(2)

		for (const img of imgs) {
			expect(img.className).toContain("size-8")
			expect(img.className).not.toContain("size-5")
		}
	})

	it("falls back to literal `:shortcode:` text for a shortcode outside both the standard table and the bundled custom subset", () => {
		const { container } = render(createElement(MessageContent, { chat: mockChat(), text: "hello :definitely_not_a_real_emoji:" }))

		expect(container.textContent).toContain(":definitely_not_a_real_emoji:")
		expect(container.querySelector("img")).toBeNull()
	})

	it("renders a standard unicode shortcode at jumbo text size when the message is emoji-only", () => {
		const { container } = render(createElement(MessageContent, { chat: mockChat(), text: ":fire:" }))

		const jumboSpan = container.querySelector(".text-3xl")
		expect(jumboSpan?.textContent).toBe("🔥")
	})
})
