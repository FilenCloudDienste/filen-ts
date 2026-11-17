// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

// Sanitized HTML in a frame that runs no script and loads nothing remote; links never navigate it: in the frame they
// open through the trusted-link gate where the engine runs listeners, and under it they are listed for every browser.

vi.mock("@/lib/trustedLinks/trustedDomainsQuery", () => ({
	useTrustedDomainsQuery: () => ({ data: new Set(["example.com"]), refetch: vi.fn() })
}))

const { SafeHtmlDocument } = await import("@/features/preview/components/safeHtmlDocument")
const { interceptFrameLinks, linkPlace, safeHtmlSrcdoc, SAFE_HTML_CSP } = await import("@/features/preview/lib/safeHtmlFrame")

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
	document.body.replaceChildren()
})

const DOCUMENT = '<html><head><style>p{margin:0}</style></head><body><p>Hi <a href="https://example.com/a">there</a></p></body></html>'

describe("SafeHtmlDocument", () => {
	it("frames the document without scripts, under its own policy, on white paper", () => {
		render(
			<SafeHtmlDocument
				html={DOCUMENT}
				links={[]}
				title="Message"
				layout="fill"
				paper
			/>
		)

		const frame = screen.getByTitle("Message")
		const srcdoc = frame.getAttribute("srcdoc") ?? ""

		expect(frame.getAttribute("sandbox")).toBe("allow-same-origin")
		expect(srcdoc.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${SAFE_HTML_CSP}">`)).toBe(
			true
		)
		expect(srcdoc).toContain("background:#fff")
		expect(srcdoc).toContain("<style>p{margin:0}</style>")
		expect(screen.queryByRole("button", { name: /Links/ })).toBeNull()
	})

	it("lists the links under the document, each opening through the gate", () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null)

		render(
			<SafeHtmlDocument
				html={DOCUMENT}
				links={[
					{ href: "https://example.com/a", text: "there" },
					{ href: "mailto:a@b.c", text: "mailto:a@b.c" }
				]}
				title="Message"
				layout="fill"
				paper
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "Links (2)" }))
		fireEvent.click(screen.getByRole("button", { name: "Open there (example.com)" }))

		expect(open).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer")
	})
})

describe("the frame's links", () => {
	function frameDocument(): Document {
		const frame = document.createElement("iframe")

		document.body.append(frame)

		const inner = frame.contentDocument

		if (inner === null) {
			throw new Error("no frame document")
		}

		inner.body.innerHTML = '<p>x <a href="https://example.com/a"><b id="in">in</b></a> <span id="out">out</span></p>'

		return inner
	}

	it("opens a clicked, middle-clicked or entered link through the host, never in the frame", () => {
		const inner = frameDocument()
		const opened: string[] = []
		const stop = interceptFrameLinks(inner, href => opened.push(href))
		const target = inner.getElementById("in")

		const view = inner.defaultView

		if (target === null || view === null) throw new Error("no link")

		const click = new view.MouseEvent("click", { bubbles: true, cancelable: true })
		const middle = new view.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
		const enter = new view.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
		const other = new view.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" })

		target.dispatchEvent(click)
		target.dispatchEvent(middle)
		target.dispatchEvent(enter)
		target.dispatchEvent(other)
		inner.getElementById("out")?.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }))

		expect([click.defaultPrevented, middle.defaultPrevented, enter.defaultPrevented, other.defaultPrevented]).toEqual([
			true,
			true,
			true,
			false
		])
		expect(opened).toEqual(["https://example.com/a", "https://example.com/a", "https://example.com/a"])

		stop()
		target.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }))
		expect(opened).toHaveLength(3)
	})

	it("names a link by its host, or its mail address", () => {
		expect(linkPlace("https://www.example.com:8443/a?b")).toBe("www.example.com:8443")
		expect(linkPlace("mailto:a%40b@c.d")).toBe("a@b@c.d")
		expect(safeHtmlSrcdoc("<p>bare</p>", false)).toBe(
			`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${SAFE_HTML_CSP}"></head><body><p>bare</p></body></html>`
		)
	})
})
