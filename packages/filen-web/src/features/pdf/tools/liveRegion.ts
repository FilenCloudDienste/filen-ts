import { useEffect } from "react"
import { pdfToolState, type PdfToolState } from "@/features/pdf/tools/toolState"

// The PDF editor's one polite live region (PdfLiveRegion, mounted empty with the viewer), so every placement position
// a tool says afterwards is announced (a region mounted together with its text often is not). Tools never render a
// live region of their own; they set its text here.

const regions = new WeakMap<object, PdfToolState<string>>()

// The region's text of one editor (keyed by its swap).
export function pdfAnnouncer(owner: object): PdfToolState<string> {
	let region = regions.get(owner)

	if (region === undefined) {
		region = pdfToolState("")
		regions.set(owner, region)
	}

	return region
}

// Says `text` in the editor's live region whenever it changes (null: says nothing new).
export function useAnnouncement(owner: object, text: string | null): void {
	useEffect(() => {
		if (text !== null) pdfAnnouncer(owner).set(text)
	}, [owner, text])
}
