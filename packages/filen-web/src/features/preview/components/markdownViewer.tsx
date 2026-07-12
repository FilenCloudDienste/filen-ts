import { lazy, Suspense, useState } from "react"
import { useTranslation } from "react-i18next"
import { CodeIcon, EyeIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { decodeUtf8 } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"

export interface MarkdownViewerProps {
	item: DriveItem
	alt: string
}

// "View source" mounts the SAME read-only CodeMirror surface every text/code file uses — a nested
// lazy() (not a plain import) so opening a markdown file never pulls CodeMirror's chunk in; it fetches
// only when the toggle is actually used, resolving to the SAME chunk previewOverlay.tsx's own
// TextViewer lazy() produces.
const TextViewer = lazy(() => import("@/features/preview/components/textViewer"))

function MarkdownToolbar({ mode, onToggle }: { mode: "rendered" | "source"; onToggle: () => void }) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex h-10 shrink-0 items-center justify-end px-2">
			<Button
				variant="ghost"
				size="sm"
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
		</div>
	)
}

// Top-level gate on the whole-buffer download (usePreviewBytes, shared with every other buffered
// category) — decodes ONCE here for the rendered view; the source toggle mounts a fully separate
// TextViewer instance with its OWN usePreviewBytes call rather than threading these same bytes through,
// trading one extra re-download (only paid if the toggle is actually used) for keeping both viewers
// independently composable, matching every other viewer's own self-contained {item, alt} shape.
function MarkdownViewer({ item, alt }: MarkdownViewerProps) {
	const result = usePreviewBytes(item)
	const [mode, setMode] = useState<"rendered" | "source">("rendered")

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
