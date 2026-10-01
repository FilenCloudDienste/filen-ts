import { useEffect, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { CodeIcon, EyeIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { codeMirrorLanguageFor, decodeUtf8, extensionOf } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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

function MarkdownToolbar({
	mode,
	disabled,
	onToggle,
	toggleRef
}: {
	mode: "rendered" | "source"
	disabled: boolean
	onToggle: () => void
	toggleRef: RefObject<HTMLButtonElement | null>
}) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex h-10 shrink-0 items-center justify-end px-2">
			{/* The tooltip is the whole point of the disabled state: it is the only thing that explains why
			    the toggle is locked. It only opens while locked — an enabled toggle already carries its own
			    visible label. */}
			<Tooltip disabled={!disabled}>
				<TooltipTrigger
					render={
						<Button
							ref={toggleRef}
							variant="ghost"
							size="sm"
							disabled={disabled}
							// aria-disabled (Base UI's focusableWhenDisabled) instead of the native disabled
							// attribute: a natively disabled button gets pointer-events:none from the Button base
							// class and drops out of the tab order, so neither hover nor focus could ever reach the
							// hint below. Clicks and keys stay inert either way — Base UI's own button handlers
							// swallow them while `disabled` is set — so the styling is all that has to be restated.
							focusableWhenDisabled
							className="aria-disabled:opacity-50"
							onClick={onToggle}
						>
							{mode === "rendered" ? (
								<>
									<CodeIcon />
									{t("previewMarkdownViewSourceAction")}
								</>
							) : (
								<>
									<EyeIcon />
									{t("previewMarkdownViewRenderedAction")}
								</>
							)}
						</Button>
					}
				/>
				<TooltipContent>{t("previewMarkdownToggleDirtyHint")}</TooltipContent>
			</Tooltip>
		</div>
	)
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category) — decodes ONCE here and feeds both views, so flipping modes never downloads again. The
// editor seeds from `text` at mount, which is safe to repeat: the toggle is locked while dirty, and a
// save rotates the uuid, remounting this whole viewer onto the new bytes.
// No parameter defaults: the React Compiler skips a component that has them.
export function MarkdownViewer({ item, alt, editable, onDirtyChange, contentRef, locked }: MarkdownViewerProps) {
	const result = usePreviewBytes(item)
	const [mode, setMode] = useState<"rendered" | "source">("rendered")
	// Where focus goes after a keyboard toggle: into the source editor, or onto the toolbar toggle when
	// the toggle unmounted the editor that had it.
	const [focusAfterToggle, setFocusAfterToggle] = useState<"editor" | "toggle" | null>(null)
	const containerRef = useRef<HTMLDivElement>(null)
	const toggleRef = useRef<HTMLButtonElement>(null)
	// Toggling back to rendered UNMOUNTS the source-mode editor, and CodeMirrorSource only reports the
	// dirty bit from a mount-time/dirty-edge effect — never on unmount — so an ungated toggle would both
	// discard the buffer and strand the overlay's dirty flag. Read from the guard store, the single
	// definition the overlay's own Save button reads too.
	const dirty = usePreviewUnsavedGuardStore(state => state.dirty)

	// Locked while dirty, like the toolbar's own toggle (see above). The key is swallowed even then:
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

	const text = decodeUtf8(result.bytes)

	return (
		<div
			ref={containerRef}
			className="flex size-full flex-col"
		>
			<MarkdownToolbar
				mode={mode}
				disabled={dirty}
				toggleRef={toggleRef}
				onToggle={() => {
					setFocusAfterToggle(null)
					setMode(prev => (prev === "rendered" ? "source" : "rendered"))
				}}
			/>
			<div className="min-h-0 flex-1">
				{mode === "source" ? (
					<CodeMirrorSource
						text={text}
						tag={codeMirrorLanguageFor(extensionOf(driveItemName(item)))}
						alt={alt}
						editable={editable ?? false}
						locked={locked ?? false}
						autoFocus={focusAfterToggle === "editor"}
						// exactOptionalPropertyTypes: an unset optional prop must omit the key entirely
						// rather than forward an explicit `undefined`.
						{...(onDirtyChange !== undefined ? { onDirtyChange } : {})}
						{...(contentRef !== undefined ? { contentRef } : {})}
					/>
				) : (
					<MarkdownRenderer
						text={text}
						alt={alt}
					/>
				)}
			</div>
		</div>
	)
}
