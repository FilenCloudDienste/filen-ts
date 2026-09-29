import { useEffect, useEffectEvent, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { type PreviewAccessMode, usePreviewAccessMode, usePreviewCacheScope } from "@/features/preview/lib/accessMode"

// `refetch` is merged onto every variant (rather than living beside the union as a sibling return
// field) so every call site's existing `result.status`-narrowing keeps working unchanged — only the
// error branch actually wires it into a Retry button (previewErrorState.tsx), but it's available on
// every status for a uniform shape.
export type PreviewLoad<T> =
	| { status: "pending"; refetch: () => void }
	| { status: "success"; value: T; refetch: () => void }
	| { status: "error"; dto: ErrorDTO; refetch: () => void }

export interface PreviewFetchContext {
	token: string
	// Aborted once the load's owner is gone.
	signal: AbortSignal
	accessMode: PreviewAccessMode
	cacheScope: string | null
	uuid: string
}

// The lifecycle shared by the preview's whole-buffer loads. Mints a fresh token per load and cancels
// the in-flight worker download (previewAborts registry, sdk.worker.ts) on unmount AND on the item's
// uuid changing, so arrow-stepping away from a still-loading file never lets its result land after the
// fact. Previews are never registered as transfers (ephemeral, own spinner, no row).
//
// Keyed on the uuid, never on the `item` object: the overlay hands over a new object for the same file
// after a favorite toggle or rename, and the uuid rotates whenever the content changes, so a
// metadata-only update must leave an in-flight download running rather than restart it from zero.
//
// The caller is expected to key its host element by the item's uuid (previewOverlay.tsx's
// PreviewBody) so a genuine item change remounts this hook fresh — the initial "pending" state then
// covers every real case with no redundant synchronous reset inside the effect (which would only
// double-render and trip react-hooks/set-state-in-effect for no behavioral gain: an item-changed
// re-run with the SAME hook instance still cancels the old token below regardless).
//
// `reloadToken` is the retry mechanism: `refetch` bumps it (and resets to "pending" synchronously, an
// ordinary event-handler setState, not an effect one) to re-run the SAME effect against the SAME item
// without needing a remount — an item change already gets a fresh load via its uuid changing, so
// `reloadToken` only ever needs to move on an explicit user retry.
//
// `seed` serves a result already cached this session on the first paint. `run` must be async, so a
// synchronous throw still lands as the error state; it reads the latest render's closure.
export function usePreviewFetch<T>(
	item: DriveItem,
	options: {
		seed: (cacheScope: string | null, uuid: string) => T | undefined
		run: (context: PreviewFetchContext) => Promise<T>
	}
): PreviewLoad<T> {
	const accessMode = usePreviewAccessMode()
	const cacheScope = usePreviewCacheScope()
	const [result, setResult] = useState<{ status: "pending" } | { status: "success"; value: T } | { status: "error"; dto: ErrorDTO }>(
		() => {
			const value = options.seed(cacheScope, item.data.uuid)

			return value === undefined ? { status: "pending" } : { status: "success", value }
		}
	)
	const [reloadToken, setReloadToken] = useState(0)
	const uuid = item.data.uuid
	const run = useEffectEvent((context: PreviewFetchContext) => options.run(context))

	useEffect(() => {
		let live = true
		const token = crypto.randomUUID()
		// A joined load that fails after this hook is gone must not restart under its token, which
		// nothing would cancel anymore.
		const gone = new AbortController()

		// Promise handlers, not try/catch: the React Compiler cannot lower one around a logical expression
		// and would skip the hook.
		void run({ token, signal: gone.signal, accessMode, cacheScope, uuid }).then(
			value => {
				if (live) {
					// Same value as the cache-seeded initial state: keep the state object so nothing re-renders.
					setResult(prev => (prev.status === "success" && prev.value === value ? prev : { status: "success", value }))
				}
			},
			(e: unknown) => {
				if (live) {
					setResult({ status: "error", dto: asErrorDTO(e) })
				}
			}
		)

		return () => {
			live = false
			gone.abort()
			void sdkApi.cancelPreviewDownload(token)
		}
	}, [uuid, reloadToken, accessMode, cacheScope])

	function refetch(): void {
		setResult({ status: "pending" })
		setReloadToken(prev => prev + 1)
	}

	return { ...result, refetch }
}
