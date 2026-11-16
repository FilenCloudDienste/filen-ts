import { type RefObject } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension, codeMirrorLanguageFor } from "@/features/drive/lib/preview.logic"
import { usePreviewTextFile } from "@/features/preview/hooks/usePreviewTextFile"
import { CodeSurface } from "@/features/preview/components/codeSurface"
import { useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { PreviewErrorState, PreviewLoading, PreviewNotTextState } from "@/features/preview/components/previewErrorState"

export interface TextViewerProps {
	item: DriveItem
	alt: string
	// Writable mode for the preview-save feature — omitted (or false) by every read-only caller, so
	// those call sites need no changes. `onDirtyChange`/`contentRef` are only ever read while
	// `editable` is true.
	editable?: boolean
	// Fired whenever the dirty bit flips (never on every keystroke) — the overlay mirrors it into its
	// own state to gate the Save button/Cmd+S/close+nav confirm, none of which this component renders
	// itself (the header lives in previewOverlay.tsx).
	onDirtyChange?: (dirty: boolean) => void
	// Side channel for the overlay's Save handler to read the CURRENT buffer on demand (Cmd+S/button
	// click) without this component re-rendering the overlay on every keystroke — a plain reactive
	// callback would force that; a ref lets the overlay pull, not push. It holds a reader, so the buffer
	// is flattened into a string only when read. See CodeMirrorSource's own prop.
	contentRef?: RefObject<(() => string) | null>
	// Read-only while the overlay saves: see CodeMirrorSource's own prop.
	locked?: boolean
	// Asked to be editable, the file turned out to be text a save would change (not strict UTF-8), or not text at
	// all: it shows read-only, and the overlay is told so.
	onReadOnly?: () => void
}

// Top-level gate on the whole-buffer download and the binary check (usePreviewTextFile), then a decode that keeps the
// file's encoding, byte order mark and line ending for its saves and a per-extension language lookup. The editor
// under its command bar lives in codeSurface.tsx — this component stays the preview-specific shell around it (byte
// loading, item-derived tag/alt).
// No parameter defaults: the React Compiler skips a component that has them.
export function TextViewer({ item, alt, editable, onDirtyChange, contentRef, locked, onReadOnly }: TextViewerProps) {
	const text = usePreviewTextFile(item, editable === true, onReadOnly)

	useLeaveViewerFullScreen()

	switch (text.status) {
		case "pending":
			return <PreviewLoading />
		case "error":
			return (
				<PreviewErrorState
					message={errorLabel(text.dto)}
					onRetry={text.refetch}
				/>
			)
		case "notText":
			return (
				<PreviewNotTextState
					item={item}
					onShowAnyway={text.showAnyway}
				/>
			)
		case "success":
			return (
				<CodeSurface
					file={text.file}
					tag={codeMirrorLanguageFor(itemTypeExtension(item))}
					alt={alt}
					editable={editable === true && text.writable}
					locked={locked ?? false}
					onDirtyChange={onDirtyChange}
					contentRef={contentRef}
				/>
			)
	}
}
