import { type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { opensAsLargeText, previewType, type PreviewCategory } from "@/features/drive/lib/preview.logic"
import type { PresentationSaveSource } from "@/features/drive/lib/previewSave.logic"
import { ArchiveBrowser } from "@/features/archive/components/archiveBrowser"
import { ComicViewer } from "@/features/comics/components/comicViewer"
import { IworkPreview } from "@/features/iwork/components/iworkPreview"
import { ImageViewer } from "@/features/preview/components/imageViewer"
import { DocxViewer } from "@/features/preview/components/docxViewer"
import type { DocxSaveSource } from "@/features/preview/components/docxEditor"
import { MarkdownViewer } from "@/features/preview/components/markdownViewer"
import { PdfViewer } from "@/features/preview/components/pdfViewer"
import { SubtitleViewer } from "@/features/preview/components/subtitleViewer"
import { CalendarViewer } from "@/features/preview/components/calendarViewer"
import { NotebookViewer } from "@/features/preview/components/notebookViewer"
import { ContactViewer } from "@/features/preview/components/contactViewer"
import { MermaidViewer } from "@/features/preview/components/mermaidViewer"
import { TextViewer } from "@/features/preview/components/textViewer"
import { LargeTextViewer } from "@/features/preview/components/largeTextViewer"
import { PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { ReadOnlyViewer } from "@/features/preview/components/readOnlyPreviewBody"
import type { TextState } from "@/features/preview/hooks/usePreviewTextFile"
import type { ImagePageSlot } from "@/features/preview/lib/imagePageSource"
import type { TextBuffer } from "@/features/preview/lib/textFile"
import { PreviewDocumentContext, previewDocumentItem } from "@/features/preview/lib/activeDocumentScope"
import type { SpreadsheetSaveSource } from "@/features/spreadsheet/save/sheetSave.logic"
import { SheetViewer } from "@/features/spreadsheet/sheetViewer"
import { PresentationViewer } from "@/features/presentation/components/presentationViewer"
import { useDeviceProfile } from "@/lib/useDeviceProfile"

export interface PreviewBodyProps {
	item: DriveItem
	variant: DriveVariant
	// The drive slot's pinned renderer (SlotPin).
	category: PreviewCategory | undefined
	documentKey: string
	editable: boolean
	// Read-only because a rename changed the save format: the spreadsheet grid says so.
	renamedReadOnly: boolean
	// A file the user cannot write (ownsWritableFile) is never editable, so a spreadsheet keeps only what it shows.
	neverEditable: boolean
	// A save in flight: text editors go read-only until it settles.
	locked: boolean
	onDirtyChange: (dirty: boolean) => void
	// The text viewer's TextState (a file a save would change leaves the slot read-only).
	onTextState: (state: TextState) => void
	// The codepage the version shown is known to be in (this overlay saved it so).
	readAs: string | null
	contentRef: RefObject<TextBuffer | null>
	spreadsheetRef: RefObject<SpreadsheetSaveSource | null>
	docxRef: RefObject<DocxSaveSource | null>
	// The presentation editor's save source (its session streams each save to the upload).
	presentationRef: RefObject<PresentationSaveSource | null>
	// The image viewer's shown <img> (the image editor starts from its pixels).
	imageRef: RefObject<HTMLImageElement | null>
	// The image viewer's page from a document engine (the image editor draws it there).
	imagePageRef: RefObject<ImagePageSlot | null>
	// A save the user asked for in the viewer (a deck's File ▸ Save); true when one started.
	onSave: () => boolean
	// Idle autosave asks the overlay to save; true when a save started.
	onAutosave: () => boolean
	// Shows another file in this slot's place (the .xlsx an .xls was just saved as).
	onOpenFile: (item: DriveItem) => void
	// A converted copy may be written beside the file (its own drive, however read-only its format).
	canSaveCopy: boolean
}

// Dispatches to the right viewer by category — remounted (keyed by uuid, see the error boundary one
// level up) on every item change so a viewer's own pending/success/error state never flashes the
// previous item's content. Bytes are no longer loaded centrally here: image/video/audio each own their
// own data source (a streamed SW URL or a buffered blob, see imageViewer.tsx/mediaViewer.tsx), and
// every other viewer loads its own bytes. The edit props reach the text family (the "text"/"code"
// case's TextViewer and the source-mode editors of the "markdown", "subtitle", "calendar", "contact" and
// "mermaid" cases), and the sheet, Word document, deck and PDF viewers; the image and video editors are
// mounted by the overlay itself. Every other category ignores them.
//
// The arms here are the overlay's own (editing props, the image editor's refs, the hosts of an archive, a comic, an
// iWork package and an unsupported file); every other category is ReadOnlyViewer's, the one definition the read-only
// body shares. A missing category arm cannot ship as a silently blank overlay: ReadOnlyViewer's exhaustive `default`
// arm is the guard (a return-type annotation is not — `ReactNode` includes `undefined`).
//
// The viewer publishes its document as the open one (activeDocument.ts) in the signed-in variants (previewDocumentItem).
export function PreviewBody(props: PreviewBodyProps): ReactNode {
	return (
		<PreviewDocumentContext value={previewDocumentItem(props.item, props.variant)}>
			<PreviewBodyContent {...props} />
		</PreviewDocumentContext>
	)
}

function PreviewBodyContent({
	item,
	variant,
	category: pinnedCategory,
	documentKey,
	editable,
	renamedReadOnly,
	neverEditable,
	locked,
	onDirtyChange,
	onTextState,
	readAs,
	contentRef,
	spreadsheetRef,
	docxRef,
	presentationRef,
	imageRef,
	imagePageRef,
	onSave,
	onAutosave,
	onOpenFile,
	canSaveCopy
}: PreviewBodyProps): ReactNode {
	const { t } = useTranslation("preview")
	const profile = useDeviceProfile()

	// Narrows `data.decryptedMeta` to the file-arm's DecryptedFileMeta (which alone carries `.mime`) —
	// previewType/canPreview already guarantee a file arm for every item that ever reaches this
	// component, but that guarantee lives in a plain function's return value, not a type predicate, so
	// TS needs this explicit narrow before a `.mime`/`.name` access type-checks.
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const alt = driveItemName(base)
	// The pinned renderer (SlotPin) where the overlay has one.
	// Stored once (rather than switching on the previewType(item) call directly) so the "video"/"audio"
	// case below can pass it straight through as MediaViewer's own narrower category prop without a
	// second, redundant resolution — a raw switch on the call expression doesn't narrow across cases.
	const category = pinnedCategory ?? previewType(item)

	// A text-family file above the cap it loads whole within: read in ranges, never editable.
	if (opensAsLargeText(category, base.data.size, profile)) {
		return (
			<LargeTextViewer
				item={item}
				alt={alt}
				publishes={category === "text" || category === "code" || category === "markdown"}
			/>
		)
	}

	switch (category) {
		case "image":
			return (
				<ImageViewer
					item={item}
					alt={alt}
					imageRef={imageRef}
					pageSourceRef={imagePageRef}
				/>
			)
		// An editable PDF is keyed by its document (bodyKey): its editor's saves stream through presentationRef's port save
		// and keep it mounted.
		case "pdf":
			return (
				<PdfViewer
					item={item}
					alt={alt}
					variant={variant}
					onOpenFile={onOpenFile}
					{...(neverEditable
						? {}
						: {
								editing: {
									writable: editable,
									onDirtyChange,
									saveRef: presentationRef,
									onSave
								}
							})}
				/>
			)
		case "spreadsheet":
			return (
				<SheetViewer
					item={item}
					documentKey={documentKey}
					alt={alt}
					editable={editable}
					{...(renamedReadOnly ? { readOnlyReason: "renamed" as const } : {})}
					neverEditable={neverEditable}
					onDirtyChange={onDirtyChange}
					saveRef={spreadsheetRef}
					onOpenFile={onOpenFile}
					canSaveCopy={canSaveCopy}
					onAutosave={onAutosave}
				/>
			)
		case "docx":
			return (
				<DocxViewer
					item={item}
					alt={alt}
					variant={variant}
					canSaveCopy={canSaveCopy}
					onOpenFile={onOpenFile}
					{...(neverEditable
						? {}
						: {
								editing: {
									writable: editable,
									renamed: renamedReadOnly,
									onDirtyChange,
									saveRef: docxRef,
									onAutosave
								}
							})}
				/>
			)
		// An editable deck is keyed by its document (bodyKey): its own saves move the session onto the saved file and
		// keep it mounted. The editor fills the overlay's presentationRef; one that cannot save shows the deck view-only.
		case "presentation":
			return (
				<PresentationViewer
					item={item}
					alt={alt}
					variant={variant}
					canSaveCopy={canSaveCopy}
					onOpenFile={onOpenFile}
					{...(neverEditable
						? {}
						: {
								editing: {
									writable: editable,
									renamed: renamedReadOnly,
									onDirtyChange,
									saveRef: presentationRef,
									onSave,
									onAutosave
								}
							})}
				/>
			)
		case "text":
		case "code":
			return (
				<TextViewer
					item={item}
					alt={alt}
					editable={editable}
					locked={locked}
					onDirtyChange={onDirtyChange}
					onTextState={onTextState}
					readAs={readAs}
					contentRef={contentRef}
				/>
			)
		case "markdown":
			return (
				<MarkdownViewer
					item={item}
					alt={alt}
					editable={editable}
					locked={locked}
					onDirtyChange={onDirtyChange}
					onTextState={onTextState}
					readAs={readAs}
					contentRef={contentRef}
				/>
			)
		case "subtitle":
			return (
				<SubtitleViewer
					item={item}
					alt={alt}
					editable={editable}
					locked={locked}
					onDirtyChange={onDirtyChange}
					onTextState={onTextState}
					readAs={readAs}
					contentRef={contentRef}
				/>
			)
		case "notebook":
			return (
				<NotebookViewer
					item={item}
					alt={alt}
					editable={editable}
					locked={locked}
					onDirtyChange={onDirtyChange}
					onTextState={onTextState}
					readAs={readAs}
					contentRef={contentRef}
				/>
			)
		case "calendar":
			return (
				<CalendarViewer
					item={item}
					alt={alt}
					editable={editable}
					locked={locked}
					onDirtyChange={onDirtyChange}
					onTextState={onTextState}
					readAs={readAs}
					contentRef={contentRef}
				/>
			)
		case "contact":
			return (
				<ContactViewer
					item={item}
					alt={alt}
					editable={editable}
					locked={locked}
					onDirtyChange={onDirtyChange}
					onTextState={onTextState}
					readAs={readAs}
					contentRef={contentRef}
				/>
			)
		case "mermaid":
			return (
				<MermaidViewer
					item={item}
					alt={alt}
					editable={editable}
					locked={locked}
					onDirtyChange={onDirtyChange}
					onTextState={onTextState}
					readAs={readAs}
					contentRef={contentRef}
				/>
			)
		case "archive":
			return (
				<ArchiveBrowser
					item={item}
					variant={variant}
				/>
			)
		case "comic":
			return (
				<ComicViewer
					item={item}
					variant={variant}
				/>
			)
		case "iwork":
			return (
				<IworkPreview
					item={item}
					alt={alt}
				/>
			)
		// canPreview excludes "other" from ever reaching the overlay; it stays only as the exhaustive
		// switch's required fallback.
		case "other":
			return (
				<PreviewUnsupportedState
					item={item}
					message={t("previewUnsupportedType")}
				/>
			)
		// Every other category shows as it does read-only (ReadOnlyViewer, exhaustive over PreviewCategory: a category
		// without a viewer is a compile error there instead of an overlay that renders nothing).
		default:
			return (
				<ReadOnlyViewer
					item={item}
					category={category}
					alt={alt}
				/>
			)
	}
}
