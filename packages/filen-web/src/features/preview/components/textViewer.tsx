import { useEffect, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { looksLikeText } from "@filen/shared/textEncoding"
import { type DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension, codeMirrorLanguageFor } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { CodeSurface } from "@/features/preview/components/codeSurface"
import { readTextFile } from "@/features/preview/lib/textFile"
import { useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"

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
	// Opened through "Open as text": a file whose type is unknown, which may turn out to be binary.
	rejectBinary?: boolean
	// Asked to be editable, the file turned out to be text a save would change (not strict UTF-8): it shows
	// read-only, and the overlay is told so.
	onReadOnly?: () => void
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category), then a decode that keeps the file's encoding, byte order mark and line ending for its saves
// (readTextFile — never throws) and a per-extension language lookup. The editor under its command bar
// lives in codeSurface.tsx — this component stays the preview-specific shell around it (byte loading,
// item-derived tag/alt).
// No parameter defaults: the React Compiler skips a component that has them.
export function TextViewer({ item, alt, editable, onDirtyChange, contentRef, locked, rejectBinary, onReadOnly }: TextViewerProps) {
	const { t } = useTranslation("preview")
	const result = usePreviewBytes(item)
	const notText = result.status === "success" && rejectBinary === true && !looksLikeText(result.bytes)
	const file = result.status === "success" && !notText ? readTextFile(result.bytes) : null
	const readOnly = editable === true && file !== null && !file.editableAsIs

	useLeaveViewerFullScreen()

	useEffect(() => {
		if (readOnly) {
			onReadOnly?.()
		}
	}, [readOnly, onReadOnly])

	if (result.status === "pending") {
		return <PreviewLoading />
	}

	if (result.status === "error") {
		return (
			<PreviewErrorState
				message={errorLabel(result.dto)}
				onRetry={result.refetch}
			/>
		)
	}

	if (file === null) {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewNotText")}
			/>
		)
	}

	return (
		<CodeSurface
			file={file}
			tag={codeMirrorLanguageFor(itemTypeExtension(item))}
			alt={alt}
			editable={editable === true && file.editableAsIs}
			locked={locked ?? false}
			onDirtyChange={onDirtyChange}
			contentRef={contentRef}
		/>
	)
}
