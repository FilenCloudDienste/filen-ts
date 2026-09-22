// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach } from "vitest"
import { createElement } from "react"
import { render, cleanup } from "@testing-library/react"
import type { Chat } from "@/types"
import type { ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"

// ─── Module boundary mocks ──────────────────────────────────────────────────

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock("zustand/shallow", () => ({
	useShallow: (fn: unknown) => fn
}))

// No in-flight messages for any of these renders — selector reads an always-empty store.
vi.mock("@/features/chats/store/useChats.store", () => ({
	default: (selector: (state: { inflightMessages: Record<string, unknown> }) => unknown) => selector({ inflightMessages: {} })
}))

// Link press behavior (the external-link trust funnel) is out of scope here — this suite tests
// segmentation + rendering only, never a real navigation.
vi.mock("@/hooks/useOpenExternalLink", () => ({
	default: () => vi.fn()
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// segmentMessage/isEmojiOnly/contactDisplayName pulled through REAL — this suite's whole point is to
// exercise the actual shared segmentation pipeline driving the rewritten component, not a stand-in.
vi.mock("@filen/shared", async () => {
	const actual = await vi.importActual<typeof import("@filen/shared")>("@filen/shared")

	return {
		cn: (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" "),
		contactDisplayName: actual.contactDisplayName,
		segmentMessage: actual.segmentMessage,
		isEmojiOnly: actual.isEmojiOnly
	}
})

vi.mock("@/components/ui/text", async () => {
	const { createElement: h } = await import("react")

	return {
		Text: (props: { children?: unknown; className?: string }) => h("span", { className: props.className }, props.children as never)
	}
})

vi.mock("@/components/ui/view", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { children?: unknown; className?: string }) => h("div", { className: props.className }, props.children as never)
	}
})

vi.mock("@/components/ui/image", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { source?: { uri?: string }; style?: unknown; className?: string }) =>
			h("img", { src: props.source?.uri, style: props.style, className: props.className })
	}
})

vi.mock("@/components/ui/pressables", async () => {
	const { createElement: h } = await import("react")

	return {
		PressableScale: (props: { children?: unknown; onPress?: () => void; className?: string }) =>
			h("button", { type: "button", className: props.className, onClick: props.onPress }, props.children as never)
	}
})

// ─── Actual import (real component + real @/lib/linkParser funnel) ─────────

import Regexed from "@/features/chats/components/chat/message/regexed"

afterEach(() => {
	cleanup()
})

function mockChat(participants: { email: string; nickName?: string }[] = []): Chat {
	return { uuid: "chat-1", participants } as unknown as Chat
}

function mockMessage(text: string | undefined): ChatMessageWithInflightId {
	return { inflightId: "inflight-1", chat: "chat-1", inner: { uuid: "msg-1", message: text } } as unknown as ChatMessageWithInflightId
}

describe("Regexed — segment mapping", () => {
	it("renders null for an undefined/empty message", () => {
		const { container } = render(createElement(Regexed, { chat: mockChat(), message: mockMessage(undefined), fromSelf: false }))

		expect(container.innerHTML).toBe("")
	})

	it("resolves a mention of a current participant to their display name", () => {
		const chat = mockChat([{ email: "alice@example.com", nickName: "Alice" }])

		const { container } = render(
			createElement(Regexed, { chat, message: mockMessage("hey @alice@example.com nice"), fromSelf: false })
		)

		const button = container.querySelector("button")
		expect(button?.textContent).toBe("@Alice")
	})

	it("renders a mention of a departed (non-participant) user as the raw email, not 'unknown'", () => {
		const { container } = render(
			createElement(Regexed, { chat: mockChat(), message: mockMessage("hey @gone@example.com nice"), fromSelf: false })
		)

		const button = container.querySelector("button")
		expect(button?.textContent).toBe("@gone@example.com")
		expect(container.textContent).not.toContain("unknown")
	})

	it("renders @everyone via the translation key", () => {
		const { container } = render(createElement(Regexed, { chat: mockChat(), message: mockMessage("@everyone hi"), fromSelf: false }))

		const button = container.querySelector("button")
		expect(button?.textContent).toBe("@everyone")
	})

	it("renders a code fence as its extracted (fence-stripped) code, not linkified", () => {
		const { container } = render(
			createElement(Regexed, { chat: mockChat(), message: mockMessage("```see https://x.com inside```"), fromSelf: false })
		)

		expect(container.textContent).toBe("see https://x.com inside")
		expect(container.querySelector("button")).toBeNull()
	})

	it("renders an eligible https link (mobile's own funnel: https-only, one sub-link, safe host) as a pressable link", () => {
		const { container } = render(
			createElement(Regexed, { chat: mockChat(), message: mockMessage("see https://example.com now"), fromSelf: false })
		)

		const button = container.querySelector("button")
		expect(button?.textContent).toBe("https://example.com")
	})

	it("does NOT render a bare http:// link as a pressable link (mobile only links https://)", () => {
		const { container } = render(
			createElement(Regexed, { chat: mockChat(), message: mockMessage("see http://example.com now"), fromSelf: false })
		)

		expect(container.querySelector("button")).toBeNull()
		expect(container.textContent).toBe("see http://example.com now")
	})

	it("renders a known custom-pack shortcode as its CDN image, at the normal (non-jumbo) size", () => {
		const { container } = render(
			createElement(Regexed, { chat: mockChat(), message: mockMessage("check this out :gigachad: nice"), fromSelf: false })
		)

		const img = container.querySelector("img")
		expect(img).not.toBeNull()
		expect(img?.getAttribute("src")).toBe("https://cdn.filen.io/emojis/gigachad.webp")
		expect(img?.style.width).toBe("20px")
	})

	it("renders a message that is ENTIRELY known custom-pack shortcodes at jumbo (32) size", () => {
		const { container } = render(
			createElement(Regexed, { chat: mockChat(), message: mockMessage(":gigachad::catjam:"), fromSelf: false })
		)

		const imgs = container.querySelectorAll("img")
		expect(imgs).toHaveLength(2)

		for (const img of imgs) {
			expect(img.style.width).toBe("32px")
		}
	})

	it("falls back to literal `:shortcode:` text for a shortcode outside the custom pack", () => {
		const { container } = render(
			createElement(Regexed, { chat: mockChat(), message: mockMessage("hello :definitely_not_a_real_emoji:"), fromSelf: false })
		)

		expect(container.textContent).toContain(":definitely_not_a_real_emoji:")
		expect(container.querySelector("img")).toBeNull()
	})

	// Named case from the batch: the shared URL source (https?:// only) no longer swallows a
	// zero-separator www.-prefixed run together with an immediately-following @mention the way
	// mobile's old broader URL_REGEX did — it now renders an inert "www.example.com" text run
	// followed by a highlighted (pressable) mention, not one unstyled blob.
	it("splits a no-separator www.-prefixed run + mention into inert text + a highlighted mention", () => {
		const { container } = render(
			createElement(Regexed, { chat: mockChat(), message: mockMessage("www.example.com@user@host.com"), fromSelf: false })
		)

		const buttons = container.querySelectorAll("button")
		expect(buttons).toHaveLength(1)
		expect(buttons[0]?.textContent).toBe("@user@host.com")

		// The remaining (non-button) text is the inert "www.example.com" run, proving it rendered as
		// plain text rather than being fused into the mention or swallowed as one inert blob.
		const withoutButton = container.cloneNode(true) as HTMLElement
		withoutButton.querySelector("button")?.remove()
		expect(withoutButton.textContent).toBe("www.example.com")
	})
})
