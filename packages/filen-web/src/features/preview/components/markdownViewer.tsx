import { useEffect, useRef, useState, type RefObject } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { codeMirrorLanguageFor, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { CodeSurface } from "@/features/preview/components/codeSurface"
import { MarkdownRenderedBar, type MarkdownBar, type MarkdownMode } from "@/features/preview/components/codeCommandBar"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { usePreviewDownload } from "@/features/preview/lib/accessMode"
import { readTextFile } from "@/features/preview/lib/textFile"
import { useLeaveViewerFullScreen } from "@/features/preview/components/commandBar.logic"
import { onCommandBarF6 } from "@/features/office/components/ribbon/ribbonFocus"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"

export interface MarkdownViewerProps {
	item: DriveItem
	alt: string
	// Same three optional props TextViewer accepts — forwarded to the source-mode editor only. The
	// rendered arm is never an editing surface.
	editable?: boolean
	onDirtyChange?: (dirty: boolean) => void
	contentRef?: RefObject<(() => string) | null>
	// Read-only while the overlay saves: see CodeMirrorSource's own prop.
	locked?: boolean
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category) — decodes ONCE here and feeds both views, so flipping modes never downloads again. The
// editor seeds from `text` at mount, which is safe to repeat: the toggle is locked while dirty, and a
// save rotates the uuid, remounting this whole viewer onto the new bytes.
// No parameter defaults: the React Compiler skips a component that has them.
export function MarkdownViewer({ item, alt, editable, onDirtyChange, contentRef, locked }: MarkdownViewerProps) {
	const result = usePreviewBytes(item)
	const download = usePreviewDownload()

	useLeaveViewerFullScreen()
	const [mode, setMode] = useState<MarkdownMode>("rendered")
	// Where focus goes after a keyboard toggle: into the source editor, or onto the command bar's switch when
	// the toggle unmounted the editor that had it.
	const [focusAfterToggle, setFocusAfterToggle] = useState<"editor" | "toggle" | null>(null)
	const containerRef = useRef<HTMLDivElement>(null)
	const toggleRef = useRef<HTMLButtonElement>(null)
	// Toggling back to rendered UNMOUNTS the source-mode editor, and CodeMirrorSource only reports the
	// dirty bit from a mount-time/dirty-edge effect — never on unmount — so an ungated toggle would both
	// discard the buffer and strand the overlay's dirty flag. Read from the guard store, the single
	// definition the overlay's own Save button reads too.
	const dirty = usePreviewUnsavedGuardStore(state => state.dirty)

	// Locked while dirty, like the command bar's switch (see above). The key is swallowed even then:
	// left to the browser, Ctrl+Shift+V pastes the clipboard over the selection, which is not what
	// pressing the toggle asks for. Works with the cursor in the editor too.
	useAction(
		"editor.togglePreview",
		keyboardEvent => {
			keyboardEvent.preventDefault()

			if (dirty) {
				return
			}

			const focusInside = containerRef.current?.contains(document.activeElement) ?? false

			setFocusAfterToggle(mode === "rendered" ? "editor" : focusInside ? "toggle" : null)
			setMode(mode === "rendered" ? "source" : "rendered")
		},
		IN_EDITORS,
		[dirty, mode]
	)

	useEffect(() => {
		if (focusAfterToggle === "toggle" && mode === "rendered") {
			toggleRef.current?.focus()
		}
	}, [focusAfterToggle, mode])

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

	const file = readTextFile(result.bytes)
	const bar: MarkdownBar = {
		mode,
		locked: dirty,
		switchRef: toggleRef,
		onMode: next => {
			setFocusAfterToggle(null)
			setMode(next)
		}
	}

	return (
		<div
			ref={containerRef}
			className="flex size-full flex-col"
			// The source's F6 is the editor surface's own (it takes the key first).
			onKeyDown={event => {
				onCommandBarF6(event, () => {
					containerRef.current?.querySelector<HTMLElement>('[role="document"]')?.focus()
				})
			}}
		>
			{mode === "source" ? (
				<CodeSurface
					file={file}
					tag={codeMirrorLanguageFor(itemTypeExtension(item))}
					alt={alt}
					editable={editable ?? false}
					locked={locked ?? false}
					autoFocus={focusAfterToggle === "editor"}
					markdown={bar}
					onDirtyChange={onDirtyChange}
					contentRef={contentRef}
				/>
			) : (
				<>
					<MarkdownRenderedBar
						markdown={bar}
						onDownload={download}
					/>
					<div className="min-h-0 flex-1">
						<MarkdownRenderer
							text={file.text}
							alt={alt}
							tabIndex={-1}
						/>
					</div>
				</>
			)}
		</div>
	)
}
