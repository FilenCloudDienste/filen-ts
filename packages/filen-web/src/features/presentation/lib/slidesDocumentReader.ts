import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { noSelection, type DocumentReader } from "@/lib/activeDocument"
import { DocumentTextBuilder, unitRange } from "@/lib/documentText"

// A deck's slides for a reader (activeDocument.ts): each slide's text and speaker notes through the session's
// read-only "text" request (no edit state), cut in the worker at the characters asked for.
export function slidesDocumentReader(session: Pick<PresentationSessionApi, "text">, slides: number): DocumentReader {
	return {
		units: () => Promise.resolve(slides),
		text: async (range, signal, maxChars) => {
			if (range === "selection") {
				return noSelection()
			}

			const builder = new DocumentTextBuilder(maxChars)
			const span = unitRange(range, slides)

			if (span === null) {
				return builder.result()
			}

			signal.throwIfAborted()

			const read = await session.text(span.from - 1, span.to - 1, maxChars)

			signal.throwIfAborted()

			for (const slide of read.slides) {
				const text = slide.notes.length === 0 ? slide.text : `${slide.text}\n\nNotes:\n${slide.notes}`

				if (!builder.add(`slide ${String(slide.index + 1)}`, text)) {
					break
				}
			}

			if (read.truncated) {
				builder.truncate()
			}

			return builder.result()
		}
	}
}
