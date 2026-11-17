// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import "@/lib/i18n"

// A link a surface intercepted itself (in a frame whose own navigation is off) opens through the same gate as a click
// on the page: a scheme the link policy refuses never opens, an untrusted domain asks first, and the rest open in a
// new tab. linkHrefOf finds the link from a node of another window.

vi.mock("@/lib/trustedLinks/trustedDomainsQuery", () => ({
	useTrustedDomainsQuery: () => ({ data: new Set(["trusted.example"]), refetch: vi.fn() })
}))

const { linkHrefOf, useTrustedLinkGate } = await import("@/lib/trustedLinks/useTrustedLinkGate")

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
	document.body.replaceChildren()
})

describe("requestOpen", () => {
	it("opens a trusted or hostless link at once, asks about an untrusted domain, refuses an unsafe scheme", () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null)
		const { result } = renderHook(() => useTrustedLinkGate())

		act(() => {
			result.current.requestOpen("https://trusted.example/a")
			result.current.requestOpen("mailto:someone@example.com")
			result.current.requestOpen("javascript:alert(1)")
			result.current.requestOpen("/relative")
		})

		expect(open.mock.calls).toEqual([
			["https://trusted.example/a", "_blank", "noopener,noreferrer"],
			["mailto:someone@example.com", "_blank", "noopener,noreferrer"]
		])

		act(() => {
			result.current.requestOpen("https://untrusted.example/b")
		})

		expect(open).toHaveBeenCalledTimes(2)
		expect(result.current.pending).toBe(true)
	})
})

describe("linkHrefOf", () => {
	it("finds the link around a node of another window", () => {
		const frame = document.createElement("iframe")

		document.body.append(frame)

		const inner = frame.contentDocument
		const anchor = inner?.createElement("a")
		const text = inner?.createTextNode("label")
		const span = inner?.createElement("span")

		if (inner === null || anchor === undefined || text === undefined || span === undefined) {
			throw new Error("no frame document")
		}

		anchor.setAttribute("href", "https://example.com/x")
		span.append(text)
		anchor.append(span)
		inner.body.append(anchor)

		expect(span instanceof Element).toBe(false)
		expect(linkHrefOf(span)).toBe("https://example.com/x")
		expect(linkHrefOf(text)).toBe("https://example.com/x")
		expect(linkHrefOf(inner.body)).toBeNull()
		expect(linkHrefOf(null)).toBeNull()
	})
})
