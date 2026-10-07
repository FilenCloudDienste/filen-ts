import { type ReactNode } from "react"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PreviewCategory } from "@/features/drive/lib/preview.logic"
import { ImageViewer, RawImageViewer } from "@/features/preview/components/imageViewer"
import { MediaViewer } from "@/features/preview/components/mediaViewer"
import { DocxViewer } from "@/features/preview/components/docxViewer"
import { MarkdownViewer } from "@/features/preview/components/markdownViewer"
import { PdfViewer } from "@/features/preview/components/pdfViewer"
import { TextViewer } from "@/features/preview/components/textViewer"
import { SpreadsheetViewer } from "@/features/spreadsheet/components/spreadsheetViewer"

// The viewer for a file shown read-only outside the preview overlay's own body: a public link's file and an
// archive's entry, each fed a fabricated DriveItem under the providers that say where its bytes come from.
// Never an editing surface. Guarded against a missing category arm by the `default` arm at the bottom,
// the same way previewOverlay's own PreviewBody is.
export function ReadOnlyPreviewBody({ item, category, alt }: { item: DriveItem; category: PreviewCategory; alt: string }): ReactNode {
	switch (category) {
		case "image":
			return (
				<ImageViewer
					item={item}
					alt={alt}
				/>
			)
		case "video":
		case "audio":
			return (
				<MediaViewer
					item={item}
					category={category}
					alt={alt}
				/>
			)
		case "pdf":
			return (
				<PdfViewer
					item={item}
					alt={alt}
				/>
			)
		case "docx":
			return (
				<DocxViewer
					item={item}
					alt={alt}
				/>
			)
		case "spreadsheet":
			return (
				<SpreadsheetViewer
					item={item}
					documentKey={item.data.uuid}
					neverEditable
					alt={alt}
				/>
			)
		case "text":
		case "code":
			return (
				<TextViewer
					item={item}
					alt={alt}
				/>
			)
		case "markdown":
			return (
				<MarkdownViewer
					item={item}
					alt={alt}
				/>
			)
		// A public link's: anonPreviewability admits rawImage, its embedded preview read through the anon
		// worker method by the provider around this. An archive's entry never asks for one.
		case "rawImage":
			return (
				<RawImageViewer
					item={item}
					alt={alt}
				/>
			)
		// Unreachable: anonPreviewability (download.logic.ts) refuses an "other" item and keeps an archive for
		// FileHero's own browser (publicArchive.tsx), and an entry opens only in the categories it loads
		// whole (entryAccess.logic.ts).
		case "archive":
		case "other":
			return null
		// `category` narrows to `never` here only while every PreviewCategory has an arm above, so adding
		// one without a viewer is a compile error on this assignment instead of a blank pane.
		default: {
			const unhandled: never = category

			return unhandled
		}
	}
}
