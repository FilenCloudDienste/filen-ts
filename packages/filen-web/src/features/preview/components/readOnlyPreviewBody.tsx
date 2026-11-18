import { type ReactNode } from "react"
import type { DriveItem } from "@/features/drive/lib/item"
import { opensAsLargeText, type PreviewCategory } from "@/features/drive/lib/preview.logic"
import { ImageViewer, RawImageViewer } from "@/features/preview/components/imageViewer"
import { MediaViewer } from "@/features/preview/components/mediaViewer"
import { DocxViewer } from "@/features/preview/components/docxViewer"
import { MarkdownViewer } from "@/features/preview/components/markdownViewer"
import { PdfViewer } from "@/features/preview/components/pdfViewer"
import { EbookViewer } from "@/features/preview/components/ebookViewer"
import { TextViewer } from "@/features/preview/components/textViewer"
import { LargeTextViewer } from "@/features/preview/components/largeTextViewer"
import { useDeviceProfile } from "@/lib/useDeviceProfile"
import { FontViewer } from "@/features/preview/components/fontViewer"
import { TorrentViewer } from "@/features/preview/components/torrentViewer"
import { EmailViewer } from "@/features/preview/components/emailViewer"
import { SubtitleViewer } from "@/features/preview/components/subtitleViewer"
import { CalendarViewer } from "@/features/preview/components/calendarViewer"
import { NotebookViewer } from "@/features/preview/components/notebookViewer"
import { ContactViewer } from "@/features/preview/components/contactViewer"
import { MermaidViewer } from "@/features/preview/components/mermaidViewer"
import { BinaryInfoViewer } from "@/features/preview/components/binaryInfoViewer"
import { SqliteViewer } from "@/features/preview/components/sqliteViewer"
import { GeoViewer } from "@/features/preview/components/geoViewer"
import { Model3dViewer } from "@/features/preview/components/model3dViewer"
import { SheetViewer } from "@/features/spreadsheet/sheetViewer"
import { PresentationViewer } from "@/features/presentation/components/presentationViewer"

// The viewer for a file shown read-only outside the preview overlay's own body: a public link's file and an
// archive's entry, each fed a fabricated DriveItem under the providers that say where its bytes come from.
// Never an editing surface. Guarded against a missing category arm by the `default` arm at the bottom,
// the same way previewOverlay's own PreviewBody is.
export function ReadOnlyPreviewBody({ item, category, alt }: { item: DriveItem; category: PreviewCategory; alt: string }): ReactNode {
	const profile = useDeviceProfile()

	// A text-family file above the cap it loads whole within: read in ranges (LargeTextViewer refuses an origin that
	// cannot be).
	if (opensAsLargeText(category, item.data.size, profile)) {
		return (
			<LargeTextViewer
				item={item}
				alt={alt}
			/>
		)
	}

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
				<SheetViewer
					item={item}
					documentKey={item.data.uuid}
					neverEditable
					alt={alt}
				/>
			)
		case "presentation":
			return (
				<PresentationViewer
					item={item}
					alt={alt}
				/>
			)
		case "ebook":
			return (
				<EbookViewer
					item={item}
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
		case "subtitle":
			return (
				<SubtitleViewer
					item={item}
					alt={alt}
				/>
			)
		case "notebook":
			return (
				<NotebookViewer
					item={item}
					alt={alt}
				/>
			)
		case "calendar":
			return (
				<CalendarViewer
					item={item}
					alt={alt}
				/>
			)
		case "contact":
			return (
				<ContactViewer
					item={item}
					alt={alt}
				/>
			)
		case "mermaid":
			return (
				<MermaidViewer
					item={item}
					alt={alt}
				/>
			)
		case "font":
			return <FontViewer item={item} />
		case "torrent":
			return <TorrentViewer item={item} />
		case "email":
			return <EmailViewer item={item} />
		case "binaryInfo":
			return <BinaryInfoViewer item={item} />
		case "sqlite":
			return <SqliteViewer item={item} />
		case "geo":
			return <GeoViewer item={item} />
		case "model3d":
			return <Model3dViewer item={item} />
		// A public link's: anonPreviewability admits rawImage, its embedded preview read through the anon
		// worker method by the provider around this. An archive's entry never asks for one.
		case "rawImage":
			return (
				<RawImageViewer
					item={item}
					alt={alt}
				/>
			)
		// Unreachable: anonPreviewability (download.logic.ts) refuses an "other" item and an iWork document (whose
		// package needs a session to list) and keeps an archive for FileHero's own browser (publicArchive.tsx), and an
		// entry opens only in the categories it loads whole (entryAccess.logic.ts).
		case "archive":
		case "iwork":
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
