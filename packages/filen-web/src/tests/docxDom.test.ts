// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { collectBlobUrls, sanitizeDocxLinks } from "@/features/preview/lib/docxDom"

function rootWith(html: string): HTMLElement {
	const root = document.createElement("div")

	root.innerHTML = html
	document.body.replaceChildren(root)

	return root
}

function anchor(root: HTMLElement, text: string): HTMLAnchorElement {
	const found = Array.from(root.querySelectorAll("a")).find(a => a.textContent === text)

	if (found === undefined) {
		throw new Error(`no anchor ${text}`)
	}

	return found
}

describe("sanitizeDocxLinks", () => {
	it("opens an external link in a new tab without an opener", () => {
		const root = rootWith(`<a href="https://example.com/page#frag">ext</a>`)

		sanitizeDocxLinks(root)

		expect(anchor(root, "ext").target).toBe("_blank")
		expect(anchor(root, "ext").rel).toBe("noreferrer")
	})

	it("drops an unsafe scheme", () => {
		const root = rootWith(`<a href="javascript:alert(1)">bad</a>`)

		sanitizeDocxLinks(root)

		expect(anchor(root, "bad").hasAttribute("href")).toBe(false)
	})

	// Resolved against the app's own URL these would pass as https and open the app in a new tab.
	it("drops an empty or relative href rather than opening the app itself", () => {
		const root = rootWith(`<a href="">empty</a><a href="docs/setup.docx">relative</a>`)

		sanitizeDocxLinks(root)

		expect(anchor(root, "empty").hasAttribute("href")).toBe(false)
		expect(anchor(root, "relative").hasAttribute("href")).toBe(false)
	})

	it("scrolls an internal bookmark link to its target in place, never navigating or opening a tab", () => {
		const root = rootWith(`<a href="#_Toc123">toc</a><p><span id="_Toc123"></span>Heading</p>`)
		const target = root.querySelector("span")
		const scrollIntoView = vi.fn()

		if (target === null) {
			throw new Error("no bookmark")
		}

		target.scrollIntoView = scrollIntoView
		sanitizeDocxLinks(root)

		const link = anchor(root, "toc")
		const event = new MouseEvent("click", { bubbles: true, cancelable: true })

		link.dispatchEvent(event)

		expect(link.target).toBe("")
		expect(event.defaultPrevented).toBe(true)
		expect(scrollIntoView).toHaveBeenCalledTimes(1)
	})
})

describe("collectBlobUrls", () => {
	it("finds the object URLs docx-preview wrote into images, VML images and style rules", () => {
		const root = rootWith(
			[
				`<style>@font-face { font-family: "A"; src: url(blob:https://app/font-1); }</style>`,
				`<style>.docx { --docx-bullet: url(blob:https://app/bullet-1) }</style>`,
				`<img src="blob:https://app/img-1">`,
				`<img src="https://example.com/remote.png">`,
				`<svg><image href="blob:https://app/vml-1"></image></svg>`,
				`<a href="blob:https://app/not-ours">link</a>`
			].join("")
		)

		expect(collectBlobUrls(root).sort()).toEqual(
			["blob:https://app/bullet-1", "blob:https://app/font-1", "blob:https://app/img-1", "blob:https://app/vml-1"].sort()
		)
	})
})
