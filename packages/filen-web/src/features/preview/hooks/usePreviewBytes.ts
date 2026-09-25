import { useEffect, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { usePreviewAccessMode, usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { getPreviewBytes, loadPreviewBytes } from "@/features/preview/lib/previewCache"

// `refetch` is merged onto every variant (rather than living beside the union as a sibling return
// field) so every call site's existing `result.status`-narrowing keeps working unchanged — only the
// error branch actually wires it into a Retry button (previewErrorState.tsx), but it's available on
// every status for a uniform shape.
export type UsePreviewBytesResult =
	| { status: "pending"; refetch: () => void }
	| { status: "success"; bytes: Uint8Array; refetch: () => void }
	| { status: "error"; dto: ErrorDTO; refetch: () => void }

// Loads one file's whole decrypted buffer for the preview overlay. Mints a fresh token per load and
// cancels the in-flight worker download (previewAborts registry, sdk.worker.ts) on unmount AND on
// `item` changing, so arrow-stepping away from a still-loading file never lets its bytes land after the
// fact. Previews are never registered as transfers (ephemeral, own spinner, no row).
//
// The caller is expected to key its host element by the item's uuid (previewOverlay.tsx's
// PreviewBody) so a genuine item change remounts this hook fresh — the initial "pending" state then
// covers every real case with no redundant synchronous reset inside the effect (which would only
// double-render and trip react-hooks/set-state-in-effect for no behavioral gain: an item-changed
// re-run with the SAME hook instance still cancels the old token below regardless).
//
// `reloadToken` is the retry mechanism: `refetch` bumps it (and resets to "pending" synchronously, an
// ordinary event-handler setState, not an effect one) to re-run the SAME effect against the SAME item
// without needing a remount — an item change already gets a fresh load via `item` itself changing, so
// `reloadToken` only ever needs to move on an explicit user retry.
//
// A buffer already loaded this session (previewCache.ts) is served without a download: the initial
// state reads it so a revisited slot renders on its first paint, and only a completed load is stored,
// so a failed or cancelled one is fetched again next time. A load of the same file already in flight
// is joined rather than repeated; this hook's token only ever cancels a fetch it started itself.
export function usePreviewBytes(item: DriveItem): UsePreviewBytesResult {
	// ★ The single byte-source seam: an "anon" ambient mode (the public-link routes) routes the whole
	// buffer through the UNAUTHENTICATED linked-file worker method instead of the authed one, so a
	// logged-out visitor never reaches requireClient. The authed app leaves this at "authed" and its
	// path is byte-for-byte unchanged. Both methods share the same previewAborts token registry, so the
	// cancel-on-unmount below reaches an anon read with no change of its own.
	const accessMode = usePreviewAccessMode()
	const cacheScope = usePreviewCacheScope()
	const [result, setResult] = useState<
		{ status: "pending" } | { status: "success"; bytes: Uint8Array } | { status: "error"; dto: ErrorDTO }
	>(() => {
		const bytes = getPreviewBytes(cacheScope, item.data.uuid)

		return bytes === undefined ? { status: "pending" } : { status: "success", bytes }
	})
	const [reloadToken, setReloadToken] = useState(0)

	useEffect(() => {
		let live = true
		const token = crypto.randomUUID()
		// A joined load that fails after this hook is gone must not restart under its token, which
		// nothing would cancel anymore.
		const gone = new AbortController()

		async function load(): Promise<void> {
			try {
				const file = narrowToAnyFile(item)
				const bytes = await loadPreviewBytes(
					cacheScope,
					item.data.uuid,
					Number(file.size),
					() =>
						runOp(
							accessMode === "anon" ? sdkApi.downloadLinkedFileBytesAnon(file, token) : sdkApi.downloadFileBytes(file, token)
						),
					{
						signal: gone.signal
					}
				)

				if (live) {
					// Same buffer as the cache-seeded initial state: keep the state object so nothing re-renders.
					setResult(prev => (prev.status === "success" && prev.bytes === bytes ? prev : { status: "success", bytes }))
				}
			} catch (e) {
				if (live) {
					setResult({ status: "error", dto: asErrorDTO(e) })
				}
			}
		}

		void load()

		return () => {
			live = false
			gone.abort()
			void sdkApi.cancelPreviewDownload(token)
		}
	}, [item, reloadToken, accessMode, cacheScope])

	function refetch(): void {
		setResult({ status: "pending" })
		setReloadToken(prev => prev + 1)
	}

	return { ...result, refetch }
}
