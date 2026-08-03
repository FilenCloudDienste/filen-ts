import { lazy, Suspense, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { CodeIcon, EyeIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { decodeUtf8 } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"

export interface MarkdownViewerProps {
	item: DriveItem
	alt: string
	// Same three optional props TextViewer already accepts — forwarded to the source-mode instance
	// only. The rendered arm is never an editing surface.
	editable?: boolean
	onDirtyChange?: (dirty: boolean) => void
	contentRef?: RefObject<string | null>
}

// "View source" mounts the SAME read-only CodeMirror surface every text/code file uses — a nested
// lazy() (not a plain import) so opening a markdown file never pulls CodeMirror's chunk in; it fetches
// only when the toggle is actually used, resolving to the SAME chunk previewOverlay.tsx's own
// TextViewer lazy() produces.
const TextViewer = lazy(() => import("@/features/preview/components/textViewer"))

function MarkdownToolbar({ mode, disabled, onToggle }: { mode: "rendered" | "source"; disabled: boolean; onToggle: () => void }) {
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
// category) — decodes ONCE here for the rendered view; the source toggle mounts a fully separate
// TextViewer instance with its OWN usePreviewBytes call rather than threading these same bytes through,
// trading one extra re-download (only paid if the toggle is actually used) for keeping both viewers
// independently composable, matching every other viewer's own self-contained {item, alt} shape.
function MarkdownViewer({ item, alt, editable = false, onDirtyChange, contentRef }: MarkdownViewerProps) {
	const result = usePreviewBytes(item)
	const [mode, setMode] = useState<"rendered" | "source">("rendered")
	// Toggling back to rendered UNMOUNTS the source-mode editor, and CodeMirrorSource only reports the
	// dirty bit from a mount-time/dirty-edge effect — never on unmount — so an ungated toggle would both
	// discard the buffer and strand the overlay's dirty flag. Read from the guard store, the single
	// definition the overlay's own Save button reads too.
	const dirty = usePreviewUnsavedGuardStore(state => state.dirty)

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

	const text = decodeUtf8(result.bytes)

	return (
		<div className="flex size-full flex-col">
			<MarkdownToolbar
				mode={mode}
				disabled={dirty}
				onToggle={() => {
					setMode(prev => (prev === "rendered" ? "source" : "rendered"))
				}}
			/>
			<div className="min-h-0 flex-1">
				{mode === "source" ? (
					<Suspense
						fallback={
							<div className="flex size-full items-center justify-center">
								<Spinner className="size-6" />
							</div>
						}
					>
						<TextViewer
							item={item}
							alt={alt}
							editable={editable}
							// exactOptionalPropertyTypes: an unset optional prop must omit the key entirely
							// rather than forward an explicit `undefined`.
							{...(onDirtyChange !== undefined ? { onDirtyChange } : {})}
							{...(contentRef !== undefined ? { contentRef } : {})}
						/>
					</Suspense>
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

export default MarkdownViewer
