import { refused } from "../../../core/presentation/model"
import type { PresenterOpen, PresenterPortal } from "../show/controller"

// The presenter view's window: a same-origin popup opened from the user's click (`window.open("", …)` returns an
// about:blank document the page's one React root portals into), with the page's stylesheets, theme and font faces
// carried over and kept in step. A popup blocker shows only as window.open returning null, which is when the
// presenter view takes the page's own window instead (the caller decides that from "blocked", never from the
// browser's name).

export interface PresenterPortalOptions {
	readonly opener: Window
	// The popup's window name (a second open reuses the window).
	readonly name?: string
	readonly title: string
	// window.open features ("popup,left=…,top=…,width=…,height=…").
	readonly features?: () => string
	// The popup was opened, closed by the user or by close().
	readonly onChange?: () => void
}

export interface PresenterPortalHandle extends PresenterPortal {
	// Where the presenter view is portaled while the popup is open.
	readonly container: HTMLElement | undefined
}

export const PRESENTER_WINDOW_NAME = "filen-presenter"

const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 760

// A popup over the opener's screen, as large as fits.
export function defaultPresenterFeatures(opener: Window): string {
	const screen = opener.screen
	const width = Math.min(DEFAULT_WIDTH, Math.max(320, Math.round(screen.availWidth * 0.9)))
	const height = Math.min(DEFAULT_HEIGHT, Math.max(240, Math.round(screen.availHeight * 0.9)))
	const left = Math.round(opener.screenX + Math.max(0, (opener.outerWidth - width) / 2))
	const top = Math.round(opener.screenY + Math.max(0, (opener.outerHeight - height) / 2))

	return `popup,left=${String(left)},top=${String(top)},width=${String(width)},height=${String(height)}`
}

// The text of a style element: its own, or its rules when a script filled the sheet through the CSSOM.
function styleText(element: HTMLStyleElement): string {
	if (element.textContent !== null && element.textContent !== "") return element.textContent

	try {
		const rules = element.sheet?.cssRules

		if (rules === undefined) return ""

		let text = ""

		for (const rule of rules) text += `${rule.cssText}\n`

		return text
	} catch {
		return ""
	}
}

function isStyleNode(node: Node): node is HTMLStyleElement | HTMLLinkElement {
	if (node.nodeType !== 1) return false

	const element = node as Element
	const name = element.localName

	return name === "style" || (name === "link" && (element.getAttribute("rel") ?? "").split(/\s+/u).includes("stylesheet"))
}

function copyStyle(node: HTMLStyleElement | HTMLLinkElement, into: Document): Element {
	if (node.localName === "link") return into.importNode(node, false)

	const style = into.createElement("style")

	for (const attribute of node.attributes) style.setAttribute(attribute.name, attribute.value)

	style.textContent = styleText(node as HTMLStyleElement)

	return style
}

function copyAttributes(from: Element, to: Element): void {
	for (const attribute of [...to.attributes]) if (!from.hasAttribute(attribute.name)) to.removeAttribute(attribute.name)

	for (const attribute of from.attributes)
		if (to.getAttribute(attribute.name) !== attribute.value) to.setAttribute(attribute.name, attribute.value)
}

interface FontFaceSetLike extends Iterable<FontFace> {
	add(face: FontFace): unknown
	addEventListener(type: "loadingdone", listener: (event: Event & { readonly fontfaces?: readonly FontFace[] }) => void): void
	removeEventListener(type: "loadingdone", listener: (event: Event & { readonly fontfaces?: readonly FontFace[] }) => void): void
}

// Faces the page added through the Font Loading API (the deck's): the popup's FontFaceSet does not see the opener's.
// A CSS-connected face cannot join another set (it throws), and the popup has the stylesheets that declare those.
function addFaces(faces: Iterable<FontFace>, into: FontFaceSetLike): void {
	for (const face of faces) {
		try {
			into.add(face)
		} catch {
			// CSS-connected.
		}
	}
}

export function createPresenterPortal(options: PresenterPortalOptions): PresenterPortalHandle {
	const opener = options.opener
	let popup: Window | undefined
	let container: HTMLElement | undefined
	let cleanup: (() => void) | undefined

	const changed = (): void => options.onChange?.()

	const teardown = (): void => {
		cleanup?.()
		cleanup = undefined
		popup = undefined
		container = undefined
	}

	const prepare = (win: Window): HTMLElement => {
		const doc = win.document
		const source = opener.document

		copyAttributes(source.documentElement, doc.documentElement)

		// The page's stylesheets in order, then kept in step (a theme or a lazily added sheet).
		const copies = new Map<Node, Element>()

		doc.head.replaceChildren()

		const charset = doc.createElement("meta")

		charset.setAttribute("charset", "utf-8")
		doc.head.append(charset)

		for (const node of source.head.childNodes) {
			if (!isStyleNode(node)) continue

			const copy = copyStyle(node, doc)

			copies.set(node, copy)
			doc.head.append(copy)
		}

		doc.title = options.title
		doc.body.replaceChildren()
		copyAttributes(source.body, doc.body)

		const root = doc.createElement("div")

		root.setAttribute("data-fo-presenter-root", "")
		root.style.cssText = "position:fixed;inset:0;overflow:hidden"
		doc.body.append(root)

		const View = opener as Window & typeof globalThis
		const observer = new View.MutationObserver(records => {
			for (const record of records) {
				if (record.type === "attributes") {
					copyAttributes(record.target as Element, record.target === source.documentElement ? doc.documentElement : doc.body)

					continue
				}

				for (const node of record.removedNodes) {
					copies.get(node)?.remove()
					copies.delete(node)
				}

				for (const node of record.addedNodes) {
					if (!isStyleNode(node) || copies.has(node)) continue

					const copy = copyStyle(node, doc)

					copies.set(node, copy)
					doc.head.append(copy)
				}
			}
		})

		observer.observe(source.documentElement, { attributes: true })
		observer.observe(source.body, { attributes: true })
		observer.observe(source.head, { childList: true })

		const fonts = source.fonts as unknown as FontFaceSetLike | undefined
		const target = doc.fonts as unknown as FontFaceSetLike | undefined
		const onFonts = (event: Event & { readonly fontfaces?: readonly FontFace[] }): void => {
			if (target !== undefined) addFaces(event.fontfaces ?? [], target)
		}

		if (fonts !== undefined && target !== undefined) {
			addFaces(fonts, target)
			fonts.addEventListener("loadingdone", onFonts)
		}

		// The user closing the popup, and the page going away (the popup has nothing to show without it).
		const onPopupGone = (): void => {
			if (popup !== win) return

			teardown()
			changed()
		}
		const onOpenerGone = (): void => {
			win.close()
		}

		win.addEventListener("pagehide", onPopupGone)
		opener.addEventListener("pagehide", onOpenerGone)

		cleanup = () => {
			observer.disconnect()
			fonts?.removeEventListener("loadingdone", onFonts)
			opener.removeEventListener("pagehide", onOpenerGone)

			try {
				win.removeEventListener("pagehide", onPopupGone)
			} catch {
				// The window is gone.
			}
		}

		return root
	}

	return {
		get window() {
			return popup !== undefined && !popup.closed ? popup : undefined
		},
		get container() {
			return popup !== undefined && !popup.closed ? container : undefined
		},
		open: (): PresenterOpen => {
			if (popup !== undefined && !popup.closed) {
				popup.focus()

				return { kind: "opened", window: popup }
			}

			teardown()

			const win = opener.open("", options.name ?? PRESENTER_WINDOW_NAME, options.features?.() ?? defaultPresenterFeatures(opener))

			if (win === null) return { kind: "blocked" }

			try {
				// Same origin: about:blank inherits the opener's.
				container = prepare(win)
			} catch (error) {
				teardown()
				win.close()

				return refused("failed", error instanceof Error ? error.message : "presenter window")
			}

			popup = win
			changed()

			return { kind: "opened", window: win }
		},
		close: () => {
			const win = popup

			teardown()
			win?.close()

			if (win !== undefined) changed()
		}
	}
}
