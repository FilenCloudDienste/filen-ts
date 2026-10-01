import type { RefObject } from "react"
import { useTranslation } from "react-i18next"
import { type DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension, codeMirrorLanguageFor, decodeUtf8, looksBinary } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"

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
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category), then a non-fatal UTF-8 decode (decodeUtf8 — never throws) and a per-extension language
// lookup. The actual CodeMirror surface (language + theme plumbing) lives in codeMirrorSource.tsx,
// shared with the notes reader — this component stays the preview-specific shell around it (byte
// loading, item-derived tag/alt).
// No parameter defaults: the React Compiler skips a component that has them.
export function TextViewer({ item, alt, editable, onDirtyChange, contentRef, locked, rejectBinary }: TextViewerProps) {
	const { t } = useTranslation("preview")
	const result = usePreviewBytes(item)

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

	if (rejectBinary === true && looksBinary(result.bytes)) {
		return (
			<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
				{t("previewNotText")}
			</div>
		)
	}

	const tag = codeMirrorLanguageFor(itemTypeExtension(item))
	const text = decodeUtf8(result.bytes)

	return (
		<CodeMirrorSource
			text={text}
			tag={tag}
			alt={alt}
			editable={editable ?? false}
			locked={locked ?? false}
			// exactOptionalPropertyTypes: CodeMirrorSource's own optional props reject an explicit
			// `undefined` value, so an unset prop here must omit the key entirely rather than forward it.
			{...(onDirtyChange !== undefined ? { onDirtyChange } : {})}
			{...(contentRef !== undefined ? { contentRef } : {})}
		/>
	)
}
