import type { PresentationDocument } from "@filen/office/react/presentation"
import { usePublishPreviewDocument } from "@/features/preview/lib/activeDocumentScope"
import { slidesDocumentReader } from "@/features/presentation/lib/slidesDocumentReader"

// The deck shown (view or editor) published as the open document once its session is up: `current` is the slide in
// view (0-based). The reader asks the deck's worker; nothing is read until a reader asks.
export function usePresentationActiveDocument(deck: PresentationDocument, current: number, editable: boolean): void {
	const session = deck.session
	const slides = deck.slides.length

	usePublishPreviewDocument(
		session === undefined
			? null
			: {
					kind: "slides",
					position: { slide: Math.min(current, Math.max(0, slides - 1)) + 1, slides },
					selection: null,
					editable,
					reader: slidesDocumentReader(session, slides)
				}
	)
}
