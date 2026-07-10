import { type DriveKey } from "@/lib/i18n"
import { type PreviewCategory } from "@/features/drive/lib/preview.logic"

// The info dialog's "Kind" row value for a file, mapping its resolved preview category to a label key.
// "other" (a non-previewable file) has no meaningful kind to name, so it returns null and the row is
// omitted — the file's MIME-type row still conveys its format. Mirrors filen-mobile's preview-type row.
export function previewKindLabelKey(category: PreviewCategory): DriveKey | null {
	switch (category) {
		case "image":
			return "drivePreviewKindImage"
		case "video":
			return "drivePreviewKindVideo"
		case "audio":
			return "drivePreviewKindAudio"
		case "pdf":
			return "drivePreviewKindPdf"
		case "docx":
			return "drivePreviewKindDocx"
		case "text":
			return "drivePreviewKindText"
		case "code":
			return "drivePreviewKindCode"
		case "markdown":
			return "drivePreviewKindMarkdown"
		case "other":
			return null
	}
}
