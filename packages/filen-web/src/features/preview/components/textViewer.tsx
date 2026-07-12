import type { RefObject } from "react"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { extensionOf, codeMirrorLanguageFor, decodeUtf8 } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Spinner } from "@/components/ui/spinner"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"

export interface TextViewerProps {
	item: DriveItem
	alt: string
	// Writable mode for the preview-save feature — omitted (or false) by every read-only caller
	// (markdownViewer.tsx's own view-source toggle never edits its source), so those call sites need
	// no changes. `onDirtyChange`/`contentRef` are only ever read while `editable` is true.
	editable?: boolean
	// Fired whenever the dirty bit flips (never on every keystroke) — the overlay mirrors it into its
	// own state to gate the Save button/Cmd+S/close+nav confirm, none of which this component renders
	// itself (the header lives in previewOverlay.tsx).
	onDirtyChange?: (dirty: boolean) => void
	// Write-only side channel for the overlay's Save handler to read the CURRENT buffer on demand
	// (Cmd+S/button click) without this component re-rendering the overlay on every keystroke — a
	// plain reactive callback would force that; a ref lets the overlay pull, not push. Kept up to date
	// from an effect (never during render — refs are an event-handler/effect-only escape hatch).
	contentRef?: RefObject<string | null>
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category), then a non-fatal UTF-8 decode (decodeUtf8 — never throws) and a per-extension language
// lookup. The actual CodeMirror surface (language-loader + theme plumbing) lives in codeMirrorSource.tsx,
// shared with the notes reader — this component stays the preview-specific shell around it (byte
// loading, item-derived tag/alt).
function TextViewer({ item, alt, editable = false, onDirtyChange, contentRef }: TextViewerProps) {
	const result = usePreviewBytes(item)

	if (result.status === "pending") {
		return (
			<div className="flex size-full items-center justify-center">
				<Spinner className="size-6" />
			</div>
		)
	}

	if (result.status === "error") {
		return (
			<PreviewErrorState
				message={errorLabel(result.dto)}
				onRetry={result.refetch}
			/>
		)
	}

	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const name = base.data.decryptedMeta?.name ?? base.data.uuid
	const tag = codeMirrorLanguageFor(extensionOf(name))
	const text = decodeUtf8(result.bytes)

	return (
		<CodeMirrorSource
			text={text}
			tag={tag}
			alt={alt}
			editable={editable}
			// exactOptionalPropertyTypes: CodeMirrorSource's own optional props reject an explicit
			// `undefined` value, so an unset prop here must omit the key entirely rather than forward it.
			{...(onDirtyChange !== undefined ? { onDirtyChange } : {})}
			{...(contentRef !== undefined ? { contentRef } : {})}
		/>
	)
}

export default TextViewer
