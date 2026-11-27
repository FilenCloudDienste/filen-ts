import { Component, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { log } from "@/lib/log"
import type { DriveItem } from "@/features/drive/lib/item"
import { PreviewErrorState, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"

interface PreviewErrorBoundaryState {
	hasError: boolean
}

// The only React API for a render-phase catch (no hook equivalent). Scoped to the preview body ONLY —
// the header (Save/prev/next/download/close) lives outside it, so the overlay stays fully closeable
// even while this is showing its fallback. A synchronous viewer throw (e.g. the markdown parser, which
// runs during render, not inside an effect) would otherwise propagate past this dialog uncaught and
// white-screen the whole app — no boundary exists anywhere else in this tree. Keyed by the slot at its
// call site (the same key PreviewBody itself remounts on) so a crash on one slot can never stick once the
// user steps to a different one. Retry renders the viewer again; Download is the host's, read from a
// PreviewDownloadableProvider above this boundary.
export class PreviewErrorBoundary extends Component<{ item: DriveItem | undefined; children: ReactNode }, PreviewErrorBoundaryState> {
	override state: PreviewErrorBoundaryState = { hasError: false }

	static getDerivedStateFromError(): PreviewErrorBoundaryState {
		return { hasError: true }
	}

	override componentDidCatch(error: unknown): void {
		log.error("preview", "viewer render failed", error)
	}

	override render(): ReactNode {
		return this.state.hasError ? (
			<PreviewRenderError
				item={this.props.item}
				onRetry={() => {
					this.setState({ hasError: false })
				}}
			/>
		) : (
			this.props.children
		)
	}
}

function PreviewRenderError({ item, onRetry }: { item: DriveItem | undefined; onRetry: () => void }) {
	const { t } = useTranslation(["preview", "common"])

	if (item === undefined) {
		return (
			<PreviewErrorState
				message={t("previewRenderError")}
				onRetry={onRetry}
			/>
		)
	}

	return (
		<PreviewUnsupportedState
			item={item}
			message={t("previewRenderError")}
			secondary={
				<Button
					variant="outline"
					onClick={onRetry}
				>
					{t("common:tryAgain")}
				</Button>
			}
		/>
	)
}
