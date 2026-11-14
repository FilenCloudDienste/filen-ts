import "@/lib/print/print.css"

// A print the app makes itself (a spreadsheet's pages, a deck's slides, a PDF's pages): the pages in a root of their
// own beside the app, shown only to the printer (print.css hides the rest of the document there), each on a sheet of
// its size (named @page rules), then the browser's print dialog. Everything goes once the dialog closes: the root, its
// stylesheet and the blob URLs its pictures were shown from.

const ROOT_CLASS = "fo-print-root"
const PAGE_CLASS = "fo-print-page"
const XLINK = "http://www.w3.org/1999/xlink"
// How long the print waits for its pictures at most: one that never decodes still prints, without it.
const DECODE_WAIT_MS = 10_000
// Browsers whose print() returns before the dialog closes still fire afterprint; one that never does gets the root
// removed after this long.
const AFTERPRINT_FALLBACK_MS = 60_000
// settle: the print waits until the root saw no change this long (pictures painted in late), at most SETTLE_MAX_MS.
const SETTLE_QUIET_MS = 400
const SETTLE_MAX_MS = 15_000

export type PrintUnit = "pt" | "px"

export interface PrintSheetSize {
	readonly width: number
	readonly height: number
	readonly unit: PrintUnit
}

export interface PrintOptions {
	// Waits for the root to stop changing first (content that paints its pictures in after it was added).
	readonly settle?: boolean
	// Checked before the dialog opens: an abort then rejects with its reason, nothing printed.
	readonly signal?: AbortSignal
}

export interface PrintRoot {
	// A page of `size`, appended to the root in order; the caller fills it.
	addPage(size: PrintSheetSize): HTMLDivElement
	// A blob URL a page shows, revoked with the root.
	keepUrl(url: string): void
	// Shows the root to the printer and opens the print dialog; resolves once it closed. The root is removed then.
	print(options?: PrintOptions): Promise<void>
	// Removes the root without printing (a cancelled print); idempotent, and a no-op once printed.
	dispose(): void
}

function cssLength(value: number, unit: PrintUnit): string {
	return `${String(value)}${unit}`
}

function pageName(size: PrintSheetSize): string {
	return `fo-print-${size.unit}-${String(Math.round(size.width * 100))}x${String(Math.round(size.height * 100))}`
}

function pageRule(name: string | null, size: PrintSheetSize): string {
	return `@page ${name ?? ""}{ size: ${cssLength(size.width, size.unit)} ${cssLength(size.height, size.unit)}; margin: 0 }`
}

// Resolves once `root` saw no change for SETTLE_QUIET_MS, or after SETTLE_MAX_MS.
function settled(root: Element): Promise<void> {
	return new Promise(resolve => {
		let quiet = window.setTimeout(done, SETTLE_QUIET_MS)
		const limit = window.setTimeout(done, SETTLE_MAX_MS)
		const observer = new MutationObserver(() => {
			window.clearTimeout(quiet)
			quiet = window.setTimeout(done, SETTLE_QUIET_MS)
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

// The pictures the pages show (HTML and SVG), decoded before the print starts: a browser prints only what has loaded by
// then.
export async function picturesDecoded(root: Element): Promise<void> {
	const urls = new Set<string>()

	for (const image of root.querySelectorAll("img, image")) {
		const url = image.getAttribute("src") ?? image.getAttribute("href") ?? image.getAttributeNS(XLINK, "href")

		if (url !== null && url !== "") urls.add(url)
	}

	if (urls.size === 0) return

	let timer: number | undefined

	await Promise.race([
		Promise.all(
			[...urls].map(url => {
				const picture = new Image()

				picture.src = url

				return picture.decode().catch(() => undefined)
			})
		),
		new Promise<void>(resolve => {
			timer = window.setTimeout(resolve, DECODE_WAIT_MS)
		})
	])
	window.clearTimeout(timer)
}

// The browser's print dialog over whatever is shown to the printer; resolves once it closed.
function printDialog(): Promise<void> {
	return new Promise(resolve => {
		let done = false
		// Armed before print(), which can block and fire afterprint before it returns.
		const fallback = window.setTimeout(() => {
			finish()
		}, AFTERPRINT_FALLBACK_MS)

		function finish(): void {
			if (done) return

			done = true
			window.removeEventListener("afterprint", finish)
			window.clearTimeout(fallback)
			resolve()
		}

		window.addEventListener("afterprint", finish)
		window.print()
	})
}

export function createPrintRoot(): PrintRoot {
	const root = document.createElement("div")
	const style = document.createElement("style")
	const sizes = new Map<string, PrintSheetSize>()
	const urls: string[] = []
	let first: PrintSheetSize | null = null
	let disposed = false

	root.className = ROOT_CLASS
	root.setAttribute("aria-hidden", "true")

	const dispose = (): void => {
		if (disposed) return

		disposed = true
		root.remove()
		style.remove()

		for (const url of urls) URL.revokeObjectURL(url)

		urls.length = 0
	}

	return {
		addPage(size) {
			const page = document.createElement("div")
			const name = pageName(size)

			first ??= size
			sizes.set(name, size)
			page.className = PAGE_CLASS
			page.style.setProperty("page", name)
			page.style.width = cssLength(size.width, size.unit)
			page.style.height = cssLength(size.height, size.unit)
			root.append(page)

			return page
		},
		keepUrl(url) {
			if (disposed) URL.revokeObjectURL(url)
			else urls.push(url)
		},
		async print(options) {
			style.textContent =
				(first === null ? "" : pageRule(null, first)) + [...sizes].map(([name, size]) => pageRule(name, size)).join("")
			document.head.append(style)
			document.body.append(root)

			const finished = (async () => {
				if (options?.settle === true) await settled(root)

				await picturesDecoded(root)
				options?.signal?.throwIfAborted()
				await printDialog()
			})()

			// Removed on every outcome: printed, aborted or failed.
			await finished.then(dispose, (error: unknown) => {
				dispose()

				throw error
			})
		},
		dispose
	}
}
