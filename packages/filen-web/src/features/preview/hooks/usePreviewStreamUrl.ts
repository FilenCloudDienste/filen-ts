import { useEffect, useEffectEvent, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { holdPreviewStream, previewOriginStreamUrl, previewStreamUrl, releasePreviewStreamSoon } from "@/features/preview/lib/previewStream"
import { usePreviewAccessMode, usePreviewCacheScope, useProvidedPreviewOrigin } from "@/features/preview/lib/accessMode"
import { forgetPreviewStreamId, getPreviewStreamId, previewCacheEpoch, setPreviewStreamId } from "@/features/preview/lib/previewCache"

// `refetch` merged onto every variant — mirrors usePreviewBytes.ts's own identical shape/rationale.
// Re-registering (rather than just re-rendering) is the correct retry here: a mid-consumption failure
// means the PREVIOUS registration's stream is already broken, so a retry must mint a fresh one, not
// reuse the stale url a plain re-render would still be holding.
export type UsePreviewStreamUrlResult =
	| { status: "pending"; refetch: () => void }
	| { status: "success"; url: string; refetch: () => void }
	| { status: "error"; refetch: () => void }

// Registers `item` against the SW's inline-preview route once per mount and returns its fetchable
// same-origin URL — mirrors usePreviewBytes.ts's own shape/lifecycle (uuid-keyed effect, a `live`
// flag guarding a late resolution after unmount/item-change) but produces a stable src URL instead of
// a whole buffer. The effect holds the id for its run and lets go in its cleanup (on unmount and on a change
// of file): the registration goes once no viewer of the id is left, and survives strict mode's re-run, which
// holds the id again at once.
//
// A registration failure resolves "error", never a thrown rejection — every caller treats that as a
// signal to fall back, not a user-facing error: an image to the buffered blob path (streamablePreview.tsx),
// audio to MediaSource (mediaViewer.tsx). An over-cap file (streamFailureAction "error") instead
// shows a labeled error state with Retry — `refetch` (see `reloadToken` below) is that retry's wiring,
// re-running this SAME registration rather than falling back to an unbounded buffered download.
//
// A revisit reuses the id this item was registered under earlier (previewCache.ts), re-registered so
// it is live again, so the element gets the same URL and the browser can answer it from what it
// already holds. A retry drops that id: a broken stream needs a URL the element has not seen.
export function usePreviewStreamUrl(item: DriveItem, name: string, contentType: string): UsePreviewStreamUrlResult {
	const [result, setResult] = useState<{ status: "pending" } | { status: "success"; url: string } | { status: "error" }>({
		status: "pending"
	})
	const [reloadToken, setReloadToken] = useState(0)
	const cacheScope = usePreviewCacheScope()
	// A public link's file reaches the service worker through an unauthenticated range port.
	const access = usePreviewAccessMode()
	const uuid = item.data.uuid
	// Read at registration time rather than keyed on: a metadata-only update (favorite, reconcile) hands
	// over a new item for the same uuid, whose registration would only be a redundant round trip to the
	// service worker for the same URL.
	const fileOf = useEffectEvent(() => narrowToAnyFile(item))
	// A provided origin read by range (an archive's entry) streams through the SDK worker's port instead.
	const provided = useProvidedPreviewOrigin()
	const providedOf = useEffectEvent(() => provided)

	useEffect(() => {
		let live = true
		const epoch = previewCacheEpoch()
		const id = getPreviewStreamId(cacheScope, uuid, contentType) ?? crypto.randomUUID()

		holdPreviewStream(id)

		// A throw anywhere in here rejects: promise handlers below, not try/catch, which the React Compiler
		// cannot lower around a logical expression and would skip the hook for.
		async function register(): Promise<string> {
			const origin = providedOf()
			const url =
				origin === null
					? await previewStreamUrl(fileOf(), name, contentType, id, { access })
					: await previewOriginStreamUrl(origin, name, contentType, id)

			setPreviewStreamId(cacheScope, uuid, contentType, id, epoch)

			return url
		}

		void register().then(
			url => {
				if (live) {
					setResult({ status: "success", url })
				}
			},
			() => {
				if (live) {
					setResult({ status: "error" })
				}
			}
		)

		return () => {
			live = false
			releasePreviewStreamSoon(id)
		}
	}, [uuid, name, contentType, reloadToken, cacheScope, access])

	function refetch(): void {
		forgetPreviewStreamId(cacheScope, item.data.uuid, contentType)
		setResult({ status: "pending" })
		setReloadToken(prev => prev + 1)
	}

	return { ...result, refetch }
}
