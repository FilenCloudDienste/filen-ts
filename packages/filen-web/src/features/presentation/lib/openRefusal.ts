import type { PresentationRefusal } from "@filen/office/core/presentation"
import type { PreviewKey } from "@/lib/i18n"

// The viewer's words for a deck that refused to open, by its typed reason.
const REFUSAL_KEYS: Partial<Record<PresentationRefusal, PreviewKey>> = {
	malformed: "previewPptxMalformed",
	tooLarge: "previewPptxTooLarge",
	tooDeep: "previewPptxTooLarge",
	rightsManaged: "previewPptxRightsManaged",
	unsupportedEncryption: "previewPptxUnsupportedEncryption",
	damagedEncryption: "previewPptxDamagedEncryption",
	// A password-protected OpenDocument deck (ODF encryption is refused, never opened).
	encrypted: "previewPptxEncrypted",
	unsupported: "previewPptxUnsupported",
	notImplemented: "previewPptxUnsupported"
}

// The words for a deck that refused to open: its reason's, else the generic failure.
export function openRefusalKey(reason: PresentationRefusal): PreviewKey {
	return REFUSAL_KEYS[reason] ?? "previewPptxLoadFailed"
}
