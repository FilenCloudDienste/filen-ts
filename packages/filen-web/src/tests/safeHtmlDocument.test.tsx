// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

// Sanitized HTML written into a sandboxed frame without scripts, behind a policy that loads nothing remote, its links
// opened by the host only: in the frame through the trusted-link gate where listeners run, and under it from a list.

vi.mock("@/lib/trustedLinks/trustedDomainsQuery", () => ({
	useTrustedDomainsQuery: () => ({ data: new Set(["example.com"]), refetch: vi.fn() })
}))

const { filled } = vi.hoisted(() => ({ filled: [] as { document: Document; html: string }[] }))

vi.mock("@/features/preview/lib/safeHtmlFrame", async () => {
	const actual = await vi.importActual<typeof import("@/features/preview/lib/safeHtmlFrame")>("@/features/preview/lib/safeHtmlFrame")

	return {
		...actual,
		// Recorded: the frame's own document is filled on its load (fillSafeHtml is covered below on a real frame).
		fillSafeHtml: (document: Document, html: string) => {
			filled.push({ document, html })
		}
	}
})

const { SafeHtmlDocument } = await import("@/features/preview/components/safeHtmlDocument")
const {
	autoHeightSteps,
	fillSafeHtml,
	interceptFrameLinks,
	linkPlace,
	nextAutoHeight,
	safeHtmlPrefix,
	SAFE_HTML_CSP,
	SAFE_HTML_MAX_CHARS
} = await vi.importActual<typeof import("@/features/preview/lib/safeHtmlFrame")>("@/features/preview/lib/safeHtmlFrame")

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
	filled.length = 0
	document.body.replaceChildren()
})

const DOCUMENT =
	'<html><head><style>p{margin:0}</style></head><body><p>Hi <a data-filen-href="https://example.com/a">there</a></p></body></html>'

describe("SafeHtmlDocument", () => {
	it("fills the frame once its policy has loaded, without scripts, the document never in its srcdoc", () => {
		render(
			<SafeHtmlDocument
				html={DOCUMENT}
				links={[]}
				title="Message"
				layout="fill"
				paper
			/>
		)

		const frame = screen.getByTitle<HTMLIFrameElement>("Message")

		expect(frame.getAttribute("sandbox")).toBe("allow-same-origin")
		expect(frame.getAttribute("srcdoc")).toBe(safeHtmlPrefix({ paper: true, autoHeight: false }))
		expect(filled).toEqual([])

		fireEvent.load(frame)

		expect(filled).toEqual([{ document: frame.contentDocument, html: DOCUMENT }])
		expect(screen.queryByRole("button", { name: /Links/ })).toBeNull()
	})

	it("shows no frame for a document past the cap", () => {
		render(
			<SafeHtmlDocument
				html={"x".repeat(SAFE_HTML_MAX_CHARS + 1)}
				links={[]}
				title="Message"
				layout="fill"
				paper
			/>
		)

		expect(screen.queryByTitle("Message")).toBeNull()
		expect(screen.getByText("This formatted content is too large to show.")).toBeTruthy()
		expect(filled).toEqual([])
	})

	it("lists the links under the document, each opening through the gate, mail extras told", () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null)

		render(
			<SafeHtmlDocument
				html={DOCUMENT}
				links={[
					{ href: "https://example.com/a", text: "there" },
					{ href: "mailto:a@b.c?bcc=spy@x.y", text: "write" }
				]}
				title="Message"
				layout="fill"
				paper
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "Links (2)" }))
		fireEvent.click(screen.getByRole("button", { name: "Open there (example.com)" }))

		expect(open).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer")
		expect(screen.getByRole("button", { name: "Open write (a@b.c, with copies to others)" })).toBeTruthy()
	})

	// The app's link policy opens tel:, sms: and maps: links without asking; a document's never open.
	it("opens only web and mail links", () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null)

		render(
			<SafeHtmlDocument
				html={DOCUMENT}
				links={[{ href: "tel:+15551234", text: "call" }]}
				title="Message"
				layout="fill"
				paper
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "Links (1)" }))
		fireEvent.click(screen.getByRole("button", { name: /Open call/ }))

		expect(open).not.toHaveBeenCalled()
	})
})

describe("the frame's document", () => {
	// The policy comes before every part of the document, whatever its markup (a literal "<head>" in an attribute).
	it("starts with its policy, then its styles", () => {
		expect(safeHtmlPrefix({ paper: true, autoHeight: true })).toBe(
			`<!doctype html><meta http-equiv="Content-Security-Policy" content="${SAFE_HTML_CSP}"><style>` +
				"[data-filen-href]{cursor:pointer;text-decoration:underline;color:LinkText}" +
				"html{background:#fff;color:#000;color-scheme:light}html,body{height:auto!important;min-height:0!important}</style>"
		)
	})
})

describe("fillSafeHtml", () => {
	it("imports the document after the frame's own head, and replaces what an earlier fill put in", () => {
		const frame = document.createElement("iframe")

		document.body.append(frame)

		const inner = frame.contentDocument

		if (inner === null) throw new Error("no frame document")

		inner.head.innerHTML = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><style>own{}</style>'
		fillSafeHtml(inner, '<html lang="x"><head><style>p{margin:0}</style></head><body dir="rtl"><p>one</p></body></html>', false)
		fillSafeHtml(inner, '<html lang="y"><head><style>p{margin:1px}</style></head><body><p>two</p></body></html>', false)

		expect(inner.documentElement.getAttribute("lang")).toBe("y")
		expect([...inner.head.children].map(child => child.outerHTML)).toEqual([
			'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">',
			"<style>own{}</style>",
			'<style data-filen-content="">p{margin:1px}</style>'
		])
		expect(inner.body.outerHTML).toBe("<body><p>two</p></body>")
	})

	// An auto-height frame is measured by its content: no stylesheet of the document may size html or body to the view.
	it("sizes an auto-height document's html and body by their content, above the document's own important rules", () => {
		const frame = document.createElement("iframe")

		document.body.append(frame)

		const inner = frame.contentDocument

		if (inner === null) throw new Error("no frame document")

		fillSafeHtml(inner, '<html style="min-height:100vh!important"><body style="height:120vh!important"><p>x</p></body></html>', true)

		for (const element of [inner.documentElement, inner.body]) {
			expect(element.style.getPropertyValue("height")).toBe("auto")
			expect(element.style.getPropertyPriority("height")).toBe("important")
			expect(element.style.getPropertyValue("min-height")).toBe("0px")
			expect(element.style.getPropertyPriority("min-height")).toBe("important")
		}
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

		inner.body.innerHTML =
			'<p>x <a data-filen-href="https://example.com/a" tabindex="0"><b id="in">in</b></a> <span id="out">out</span></p>'

		return inner
	}

	it("opens a clicked, middle-clicked or entered link through the host, once for a held key", () => {
		const inner = frameDocument()
		const opened: string[] = []
		const stop = interceptFrameLinks(inner, href => opened.push(href))
		const target = inner.getElementById("in")
		const view = inner.defaultView

		if (target === null || view === null) throw new Error("no link")

		const click = new view.MouseEvent("click", { bubbles: true, cancelable: true })
		const middle = new view.MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
		const enter = new view.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })
		const held = new view.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", repeat: true })
		const other = new view.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a" })

		for (const event of [click, middle, enter, held, other]) {
			target.dispatchEvent(event)
		}

		inner.getElementById("out")?.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }))

		expect([click, middle, enter, held, other].map(event => event.defaultPrevented)).toEqual([true, true, true, false, false])
		expect(opened).toEqual(["https://example.com/a", "https://example.com/a", "https://example.com/a"])

		stop()
		target.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }))
		expect(opened).toHaveLength(3)
	})

	it("names a link by its host, or its whole mail address without bidi controls, telling extras", () => {
		expect(linkPlace("https://www.example.com:8443/a?b")).toEqual({ place: "www.example.com:8443", extras: null })
		expect(linkPlace("mailto:a%E2%80%AEb@c.d")).toEqual({ place: "ab@c.d", extras: null })
		expect(linkPlace("mailto:a@b.c?CC=x@y.z")).toEqual({ place: "a@b.c", extras: "copies" })
		expect(linkPlace("mailto:a@b.c?subject=hi")).toEqual({ place: "a@b.c", extras: "parameters" })
	})
})

describe("nextAutoHeight", () => {
	it("follows the content up to the cap, and holds content that follows the frame's own height", () => {
		expect(nextAutoHeight(150, { height: 300.2, followsFrame: false }, 4000)).toBe(301)
		expect(nextAutoHeight(301, { height: 280, followsFrame: false }, 4000)).toBe(280)
		expect(nextAutoHeight(600, { height: 5000, followsFrame: false }, 4000)).toBe(4000)
		// min-height:120vh, or 100vh plus padding: held, it scrolls inside.
		expect(nextAutoHeight(150, { height: 180, followsFrame: true }, 4000)).toBe(150)
	})

	// A media query on the frame's height: 1000px tall below 601px, 100px above. Held at the second height, for good.
	it("holds a height that flips with the frame instead of following it forever", () => {
		const step = autoHeightSteps(4000)
		const flipping = (frame: number) => ({ height: frame <= 600 ? 1016 : 116, followsFrame: false })

		let frame = 150
		const given: number[] = []

		for (let call = 0; call < 10; call++) {
			const next = step(frame, flipping(frame))

			given.push(next)
			frame = next
		}

		expect(given).toEqual([1016, 116, 116, 116, 116, 116, 116, 116, 116, 116])
	})

	it("keeps following content that settles, growing and shrinking", () => {
		const step = autoHeightSteps(4000)

		expect([step(150, { height: 300, followsFrame: false }), step(300, { height: 420, followsFrame: false })]).toEqual([300, 420])
		expect(step(420, { height: 420, followsFrame: false })).toBe(420)
		expect(step(420, { height: 380, followsFrame: false })).toBe(380)
	})
})
