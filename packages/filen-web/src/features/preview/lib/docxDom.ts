import { isSafeLinkHref } from "@/features/preview/components/docxViewer.logic"

// DOM passes over docx-preview's rendered output (docxViewer.tsx), kept apart from the component so
// they can be exercised on a plain DOM tree.

function isAbsoluteUrl(href: string): boolean {
	try {
		return new URL(href).protocol.length > 0
	} catch {
		return false
	}
}

function findById(root: HTMLElement, id: string): Element | undefined {
	return Array.from(root.querySelectorAll("[id]")).find(el => el.id === id)
}

// renderHyperlink copies a relationship's target straight into `href` with no scheme check of its own,
// and writes an internal link (a table-of-contents entry, a cross-reference) as a bare "#bookmark"
// whose target is a `<span id>` in the same render. The RAW attribute is what is judged: the resolved
// `.href` would fill in this app's own origin, so an internal or relative link would pass as https and
// open a second copy of the app in a new tab.
export function sanitizeDocxLinks(root: HTMLElement): void {
	for (const anchor of root.querySelectorAll("a[href]")) {
		if (!(anchor instanceof HTMLAnchorElement)) {
			continue
		}

		const raw = anchor.getAttribute("href") ?? ""

		if (raw.length > 1 && raw.startsWith("#")) {
			const id = raw.slice(1)

			// Scrolls within the preview and never touches the location, which belongs to the app's router.
			anchor.addEventListener("click", event => {
				event.preventDefault()
				findById(root, id)?.scrollIntoView({ block: "start" })
			})

			continue
		}

		if (!isAbsoluteUrl(raw) || !isSafeLinkHref(raw)) {
			anchor.removeAttribute("href")

			continue
		}

		// docx-preview emits no target/rel at all, so a click would otherwise navigate this app's own
		// tab away to whatever the document links to. target="_blank" + rel="noreferrer" (this app's
		// external-link convention, registerForm.tsx) keeps the preview in place and drops the new
		// tab's window.opener access.
		anchor.target = "_blank"
		anchor.rel = "noreferrer"
	}
}

const STYLE_BLOB_URL = /url\(\s*["']?(blob:[^)"'\s]+)/g

// docx-preview mints an object URL for every embedded image, bullet image and font and never revokes
// one. They surface as <img src>, VML <image href> and url(...) inside the <style> elements it writes
// into the same container, which is where the caller collects them to revoke on teardown.
export function collectBlobUrls(root: HTMLElement): string[] {
	const urls: string[] = []

	for (const img of root.querySelectorAll("img")) {
		const src = img.getAttribute("src")

		if (src?.startsWith("blob:") === true) {
			urls.push(src)
		}
	}

	for (const image of root.querySelectorAll("image")) {
		const href = image.getAttribute("href") ?? image.getAttribute("xlink:href")

		if (href?.startsWith("blob:") === true) {
			urls.push(href)
		}
	}

	for (const style of root.querySelectorAll("style")) {
		for (const match of style.textContent.matchAll(STYLE_BLOB_URL)) {
			if (match[1] !== undefined) {
				urls.push(match[1])
			}
		}
	}

	return urls
}
