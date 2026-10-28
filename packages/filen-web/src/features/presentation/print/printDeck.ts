import type { SlideRef } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { paintSlide, type PaintedSlide } from "@filen/office/react/presentation"
import "@/features/presentation/print/presentationPrint.css"

// Print: the deck's shown slides painted by the slide compositor (vector drawings and real text, as on screen) into a
// root of their own beside the app, one per sheet of the slide's size (@page), then the browser's print dialog. Slides
// are rendered a few at a time and painted one per frame, so no main-thread task runs long; the root goes away once
// the dialog closes.

const ROOT_CLASS = "fo-pptx-print-root"
// Renders asked for at once.
const BATCH = 4
// The print waits for pictures until nothing changed this long, and at most WAIT_MS in all: a picture that never
// arrives still prints, without it.
const QUIET_MS = 400
const WAIT_MS = 15_000

export interface PrintDeckOptions {
	readonly session: PresentationSessionApi
	readonly slides: readonly SlideRef[]
	// Slide px.
	readonly width: number
	readonly height: number
	readonly signal: AbortSignal
	readonly onProgress?: (done: number, total: number) => void
}

function frame(): Promise<void> {
	return new Promise(resolve => {
		requestAnimationFrame(() => {
			resolve()
		})
	})
}

// Resolves once `root` saw no change for QUIET_MS (its pictures arrived), or after WAIT_MS.
function settled(root: Element): Promise<void> {
	return new Promise(resolve => {
		let quiet = window.setTimeout(done, QUIET_MS)
		const limit = window.setTimeout(done, WAIT_MS)
		const observer = new MutationObserver(() => {
			window.clearTimeout(quiet)
			quiet = window.setTimeout(done, QUIET_MS)
		})

		function done(): void {
			observer.disconnect()
			window.clearTimeout(quiet)
			window.clearTimeout(limit)
			resolve()
		}

		observer.observe(root, { subtree: true, childList: true, attributes: true })
	})
}

// The pictures painted, decoded: a browser prints only what has loaded by then.
async function picturesDecoded(root: Element): Promise<void> {
	const urls = new Set<string>()

	for (const image of root.querySelectorAll("image, img")) {
		const url = image.getAttribute("href") ?? image.getAttribute("src")

		if (url !== null && url !== "") urls.add(url)
	}

	await Promise.all(
		[...urls].map(url => {
			const picture = new Image()

			picture.src = url

			return picture.decode().catch(() => undefined)
		})
	)
}

// Prints the slides; resolves once the print dialog closed (rejects with the abort's reason when cancelled first).
export async function printDeck(options: PrintDeckOptions): Promise<void> {
	const { session, slides, signal } = options
	const root = document.createElement("div")
	const style = document.createElement("style")
	const painted: PaintedSlide[] = []
	const width = Math.max(1, Math.round(options.width))
	const height = Math.max(1, Math.round(options.height))

	root.className = ROOT_CLASS
	root.setAttribute("aria-hidden", "true")
	style.textContent = `@page { size: ${String(width)}px ${String(height)}px; margin: 0 }`

	try {
		for (let at = 0; at < slides.length; at += BATCH) {
			const renders = await session.render(slides.slice(at, at + BATCH))

			for (const render of renders) {
				signal.throwIfAborted()

				const page = document.createElement("div")
				const slide = paintSlide(render, { document, session, signal })

				page.className = "fo-pptx-print-page"
				page.style.width = `${String(width)}px`
				page.style.height = `${String(height)}px`
				page.append(slide.root)
				root.append(page)
				painted.push(slide)
				options.onProgress?.(painted.length, slides.length)
				await frame()
			}
		}

		document.head.append(style)
		document.body.append(root)
		await settled(root)
		await picturesDecoded(root)
		signal.throwIfAborted()

		await new Promise<void>(resolve => {
			let done = false
			const finish = (): void => {
				if (done) return

				done = true
				window.removeEventListener("afterprint", finish)
				resolve()
			}

			window.addEventListener("afterprint", finish)
			window.print()
			// Browsers whose print() returns before the dialog closes still fire afterprint; one that never does gets the
			// root removed after a while.
			window.setTimeout(finish, 60_000)
		})
	} finally {
		root.remove()
		style.remove()

		for (const slide of painted) slide.release()
	}
}
