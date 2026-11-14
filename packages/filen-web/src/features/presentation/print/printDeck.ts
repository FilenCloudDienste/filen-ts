import type { SlideRef } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { paintSlide, type PaintedSlide } from "@filen/office/react/presentation"
import { createPrintRoot } from "@/lib/print/printRoot"
import "@/features/presentation/print/presentationPrint.css"

// Print: the deck's shown slides painted by the slide compositor (vector drawings and real text, as on screen) into the
// shared print root (lib/print/printRoot.ts), one per sheet of the slide's size, then the browser's print dialog.
// Slides are rendered a few at a time and painted one per frame, so no main-thread task runs long; the root goes away
// once the dialog closes.

// Renders asked for at once.
const BATCH = 4

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

// Prints the slides; resolves once the print dialog closed (rejects with the abort's reason when cancelled first).
export async function printDeck(options: PrintDeckOptions): Promise<void> {
	const { session, slides, signal } = options
	const root = createPrintRoot()
	const painted: PaintedSlide[] = []
	const size = { width: Math.max(1, Math.round(options.width)), height: Math.max(1, Math.round(options.height)), unit: "px" } as const

	try {
		for (let at = 0; at < slides.length; at += BATCH) {
			const renders = await session.render(slides.slice(at, at + BATCH))

			for (const render of renders) {
				signal.throwIfAborted()

				const slide = paintSlide(render, { document, session, signal })

				root.addPage(size).append(slide.root)
				painted.push(slide)
				options.onProgress?.(painted.length, slides.length)
				await frame()
			}
		}

		// The slides paint their pictures in after they are shown: the print waits for them to settle.
		await root.print({ settle: true, signal })
	} finally {
		root.dispose()

		for (const slide of painted) slide.release()
	}
}
