// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach } from "vitest"
import { createElement } from "react"
import { render, cleanup, fireEvent } from "@testing-library/react"
import type { Chat } from "@/types"
import type { ChatMessageWithInflightId } from "@/features/chats/store/useChats.store"

const openExternalLink = vi.hoisted(() => vi.fn((_url: string) => Promise.resolve()))
const segmentMessage = vi.hoisted(() => vi.fn())

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

// The external-link trust funnel itself is out of scope here, never a real navigation — the spy only
// records which URL a pressed link hands it.
vi.mock("@/hooks/useOpenExternalLink", () => ({
	default: () => openExternalLink
}))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// segmentMessage/isEmojiOnly/contactDisplayName pulled through REAL — this suite's whole point is to
// exercise the actual shared segmentation pipeline driving the rewritten component, not a stand-in.
// segmentMessage runs through a spy only to count the passes.
vi.mock("@filen/shared", async () => {
	const actual = await vi.importActual<typeof import("@filen/shared")>("@filen/shared")

	segmentMessage.mockImplementation(actual.segmentMessage)

	return {
		cn: (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" "),
		contactDisplayName: actual.contactDisplayName,
		segmentMessage,
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
	openExternalLink.mockClear()
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

	it("renders an unresolved skin-tone shortcode exactly as it was sent", () => {
		const { container } = render(
			createElement(Regexed, { chat: mockChat(), message: mockMessage("nice :thumbsup::skin-tone-2:"), fromSelf: false })
		)

		expect(container.textContent).toBe("nice :thumbsup::skin-tone-2:")
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

describe("Regexed — where a link ends", () => {
	function renderText(text: string) {
		return render(createElement(Regexed, { chat: mockChat(), message: mockMessage(text), fromSelf: false })).container
	}

	// A URL ends before a closing quote, backtick or angle bracket: the link must show and open the clean
	// URL, with the delimiters left as plain text around it.
	it.each([
		["\"https://example.com/path\"", "https://example.com/path"],
		["'https://example.com'", "https://example.com"],
		["`https://example.com`", "https://example.com"],
		["<https://example.com>", "https://example.com"],
		["<https://example.com/path>", "https://example.com/path"],
		["('https://example.com/path'),", "https://example.com/path"]
	])("links only the URL in %s", (wrapped, url) => {
		const container = renderText(`see ${wrapped} now`)
		const buttons = container.querySelectorAll("button")

		expect(buttons).toHaveLength(1)
		expect(buttons[0]?.textContent).toBe(url)
		expect(container.textContent).toBe(`see ${wrapped} now`)

		fireEvent.click(buttons[0] as HTMLElement)

		expect(openExternalLink).toHaveBeenCalledExactlyOnceWith(url)
	})

	it("opens a quoted public link with its whole key and nothing after it", () => {
		const url = `https://app.filen.io/f/00000000-0000-0000-0000-000000000000#${"ab".repeat(32)}`
		const container = renderText(`see "${url}" now`)
		const button = container.querySelector("button")

		expect(button?.textContent).toBe(url)

		fireEvent.click(button as HTMLElement)

		expect(openExternalLink).toHaveBeenCalledExactlyOnceWith(url)
	})

	it("keeps an apostrophe between letters in the path as part of the link", () => {
		const url = "https://en.wikipedia.org/wiki/Hitchhiker's_Guide"
		const container = renderText(`read ${url} first`)
		const button = container.querySelector("button")

		expect(button?.textContent).toBe(url)

		fireEvent.click(button as HTMLElement)

		expect(openExternalLink).toHaveBeenCalledExactlyOnceWith(url)
	})

	it("ends the host at an apostrophe", () => {
		const container = renderText("https://example.com's pricing")
		const buttons = container.querySelectorAll("button")

		expect(buttons).toHaveLength(1)
		expect(buttons[0]?.textContent).toBe("https://example.com")
		expect(container.textContent).toBe("https://example.com's pricing")
	})

	it("links each URL of a run with no spaces, and segments what follows each one", () => {
		const container = renderText("[\"https://a.example.com\",\"https://b.example.com\"]:gigachad:")
		const buttons = container.querySelectorAll("button")

		expect([...buttons].map(button => button.textContent)).toEqual(["https://a.example.com", "https://b.example.com"])
		expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn.filen.io/emojis/gigachad.webp")
		expect(container.textContent).toBe("[\"https://a.example.com\",\"https://b.example.com\"]")
	})

	// Any participant can send this. Cutting each link and segmenting the rest of its run again recurses
	// once per link: quadratic in the run, and deep enough to overflow the stack while rendering.
	it("renders a message-length run of thousands of links with no spaces in one segmentation pass", () => {
		const text = "http://a\"".repeat(7274)

		segmentMessage.mockClear()

		const container = renderText(text)

		expect(segmentMessage).toHaveBeenCalledOnce()
		expect(container.textContent).toBe(text)
		expect(container.querySelector("button")).toBeNull()
	})
})
