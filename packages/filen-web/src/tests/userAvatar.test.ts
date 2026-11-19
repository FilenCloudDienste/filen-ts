// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { contactInitials } from "@/components/userAvatar.logic"
import { UserAvatar } from "@/components/userAvatar"

// Base UI's Avatar only mounts <img> once the image has loaded, which never happens in jsdom: a plain
// stand-in shows what the sink hands it.
vi.mock("@/components/ui/avatar", () => ({
	Avatar: ({ children }: { children: ReactNode }) => createElement("span", null, children),
	AvatarImage: ({ src }: { src: string }) => createElement("img", { src, alt: "" }),
	AvatarFallback: ({ children }: { children: ReactNode }) => createElement("span", { "data-testid": "fallback" }, children)
}))

describe("contactInitials", () => {
	it("uppercases the first character of the display name", () => {
		expect(contactInitials("alice")).toBe("A")
	})

	it("trims leading whitespace before taking the first character", () => {
		expect(contactInitials("  bob")).toBe("B")
	})

	it("falls back to a placeholder for an empty display name", () => {
		expect(contactInitials("")).toBe("?")
		expect(contactInitials("   ")).toBe("?")
	})

	it("keeps an astral emoji whole", () => {
		expect(contactInitials("\u{1F600} Bob")).toBe("\u{1F600}")
	})

	it("keeps a CJK Extension B character whole", () => {
		expect(contactInitials("\u{20BB7}田")).toBe("\u{20BB7}")
	})

	it("keeps a base letter and its combining mark together, uppercased", () => {
		expect(contactInitials("émile")).toBe("É")
	})

	it("keeps a flag emoji whole", () => {
		expect(contactInitials("\u{1F1E9}\u{1F1EA} Team")).toBe("\u{1F1E9}\u{1F1EA}")
	})
})

describe("UserAvatar", () => {
	afterEach(() => {
		cleanup()
	})

	it("renders no image for a non-URL placeholder and shows the initials", () => {
		const { container } = render(createElement(UserAvatar, { src: "none", name: "alice" }))

		expect(container.querySelector("img")).toBeNull()
		expect(screen.getByTestId("fallback").textContent).toBe("A")
	})

	it("renders no image for a relative path", () => {
		const { container } = render(createElement(UserAvatar, { src: "avatars/a.png", name: "alice" }))

		expect(container.querySelector("img")).toBeNull()
	})

	it("renders the image for an https source", () => {
		const { container } = render(createElement(UserAvatar, { src: "https://cdn.example/a.png", name: "alice" }))

		expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example/a.png")
	})
})
