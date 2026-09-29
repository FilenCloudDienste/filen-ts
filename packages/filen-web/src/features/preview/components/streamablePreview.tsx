import { useEffect, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { driveItemMime, type DriveItem } from "@/features/drive/lib/item"
import { allowedMediaContentType } from "@/features/preview/lib/mediaType"
import { isMediaStreamAvailable } from "@/features/preview/lib/previewStream"
import { streamFailureAction } from "@/features/drive/lib/preview.logic"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { usePreviewStreamUrl } from "@/features/preview/hooks/usePreviewStreamUrl"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import { useObjectUrl } from "@/lib/useObjectUrl"
import { PreviewErrorState, PreviewGate, PreviewLoading } from "@/features/preview/components/previewErrorState"

// Renders the element for a resolved URL. `onError` is set only on the streamed path — the buffered
// blob path has nowhere further to fall back to, so it keeps the browser's own native error state.
export type RenderPreviewUrl = (url: string, onError: (() => void) | undefined) => ReactNode

// Streamed mode: registers against the SW's inline route and renders once a URL resolves. A
// registration failure hands control back to the parent (onFallback) for the buffered fallback ONLY
// when the file is under the whole-buffer cap (streamFailureAction, the SAME decision the mid-
// consumption onError handler below applies) — an oversize file gets the labeled error state instead,
// never an unbounded buffered retry (a multi-GB video on a prod SW hiccup would otherwise whole-buffer
// straight into a tab-crashing allocation, since a streamed category is never capped at the open gate,
// preview.logic.ts).
function StreamedPreview({
	item,
	contentType,
	onFallback,
	render
}: {
	item: DriveItem
	contentType: string
	onFallback: () => void
	render: RenderPreviewUrl
}) {
	const { t } = useTranslation("preview")
	const name = driveItemName(item)
	const result = usePreviewStreamUrl(item, name, contentType)
	// Mid-consumption-only (set from the onError DOM event below, a genuine event handler — never an
	// effect). The registration-failure case is deliberately NOT routed through this: see
	// registrationOverCap just below for why.
	const [capExceeded, setCapExceeded] = useState(false)
	// A pure derivation, not a second setCapExceeded(true) from the effect below: `result.status`/`item`
	// are already reactive inputs, so an over-cap REGISTRATION failure needs no stored state or effect-
	// time setState to recompute this fresh each render (react-hooks/set-state-in-effect flags exactly
	// that — a direct setState call synchronously inside an effect body — which the onError handler below
	// is exempt from only because it's a genuine DOM event callback, not an effect).
	const registrationOverCap = result.status === "error" && streamFailureAction(item) === "error"

	useEffect(() => {
		if (result.status === "error" && streamFailureAction(item) === "buffer") {
			onFallback()
		}
	}, [result.status, onFallback, item])

	// Checked BEFORE the pending/error spinner below: an over-cap REGISTRATION failure leaves
	// `result.status` permanently "error" (never "success"), so this must win regardless of that status,
	// not just after it — unlike the mid-consumption path, where `result.status` is already "success" by
	// the time onError can ever set `capExceeded`, so the ordering is a no-op there.
	if (capExceeded || registrationOverCap) {
		return (
			<PreviewErrorState
				message={t("previewStreamFailed")}
				onRetry={() => {
					setCapExceeded(false)
					result.refetch()
				}}
			/>
		)
	}

	if (result.status !== "success") {
		return <PreviewLoading />
	}

	return render(result.url, () => {
		// A mid-consumption failure (network drop mid-load/seek, an SW-side decrypt abort, a lifecycle
		// hiccup) — unlike the registration-failure effect above, retrying buffered here would
		// re-download the whole file, so an oversize item gets the labeled error instead.
		if (streamFailureAction(item) === "buffer") {
			onFallback()
		} else {
			setCapExceeded(true)
		}
	})
}

function BufferedPreviewBytes({ bytes, mime, render }: { bytes: Uint8Array; mime: string | undefined; render: RenderPreviewUrl }) {
	const url = useObjectUrl(bytes, mime)

	if (!url) {
		return null
	}

	return render(url, undefined)
}

// Buffered mode: a whole-file download played back from a blob URL, minted/revoked by useObjectUrl so
// the blob never outlives it. Unlike the streamed path this is NEVER size-capped for video/audio
// (STREAMED_CATEGORIES, preview.logic.ts) — an accepted tradeoff of the dev/SW-absent fallback.
function BufferedPreview({ item, render }: { item: DriveItem; render: RenderPreviewUrl }) {
	return (
		<PreviewGate result={usePreviewBytes(item)}>
			{ready => (
				<BufferedPreviewBytes
					bytes={ready.bytes}
					mime={driveItemMime(item)}
					render={render}
				/>
			)}
		</PreviewGate>
	)
}

// Picks the SW's inline-preview route (streamed, seekable, no whole-buffer download) when a service
// worker is controlling the tab AND this item's mime passes the inline allowlist, else falls back to
// the buffered whole-file blob path (dev / SW absent / a failed stream registration) — see
// previewStream.ts's isMediaStreamAvailable for the single capability flip point. The buffered path is
// also where an item the allowlist rejects outright (e.g. an unrecognized mime) always lands.
export function StreamablePreview({ item, render }: { item: DriveItem; render: RenderPreviewUrl }) {
	const contentType = allowedMediaContentType(item)
	// An "anon" ambient mode (a public link) can never stream: the service worker's wasm bundle has no
	// UnauthClient, so the buffered path is the only one that serves a logged-out visitor.
	const accessMode = usePreviewAccessMode()
	const streamable = contentType !== null && isMediaStreamAvailable() && accessMode === "authed"
	const [useBuffered, setUseBuffered] = useState(!streamable)

	if (!useBuffered && contentType !== null) {
		return (
			<StreamedPreview
				item={item}
				contentType={contentType}
				onFallback={() => {
					setUseBuffered(true)
				}}
				render={render}
			/>
		)
	}

	return (
		<BufferedPreview
			item={item}
			render={render}
		/>
	)
}
