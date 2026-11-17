import type { EmailSanitizeResult } from "@filen/shared/dom"
import { sanitizeEmailHtml } from "@/features/preview/lib/emailSanitizer"

// The object URL a Content-ID resolves to, and the part (its index) that URL shows: the first raster part with that id.
export interface CidPicture {
	readonly url: string
	readonly part: number
}

// The HTML sanitized, and the parts (by index) it shows in place: those are not listed. None when the sanitized HTML
// is too large to show, so every part stays reachable.
export function sanitizeBody(
	html: string,
	cidUrls: ReadonlyMap<string, CidPicture>
): { sanitized: EmailSanitizeResult; shown: ReadonlySet<number> } {
	const shown = new Set<number>()
	const sanitized = sanitizeEmailHtml(html, id => {
		const picture = cidUrls.get(id)

		if (picture === undefined) return null

		shown.add(picture.part)

		return picture.url
	})

	return { sanitized, shown: sanitized.tooLarge ? new Set() : shown }
}
