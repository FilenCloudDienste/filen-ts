import { type DriveItem } from "@/features/drive/lib/item"
import { originSize } from "@/lib/sdk/byteOrigin"
import { getPreviewBytes } from "@/features/preview/lib/previewCache"
import { usePreviewOrigin } from "@/features/preview/lib/accessMode"
import { loadOriginBytes } from "@/features/preview/lib/origin/loadBytes"
import { type PreviewLoad, usePreviewFetch } from "@/features/preview/hooks/usePreviewFetch"

export type UsePreviewBytesResult =
	Exclude<PreviewLoad<Uint8Array>, { status: "success" }> | { status: "success"; bytes: Uint8Array; refetch: () => void }

// Loads one file's whole decrypted buffer for the preview overlay, with usePreviewFetch's lifecycle.
//
// A buffer already loaded this session (previewCache.ts) is served without a download: the initial
// state reads it so a revisited slot renders on its first paint, and only a completed load is stored,
// so a failed or cancelled one is fetched again next time. A load of the same file already in flight
// is joined rather than repeated; this hook's token only ever cancels a fetch it started itself.
//
// ★ The bytes come from the viewer's origin (usePreviewOrigin): a public link's surface yields only an
// unauthenticated read, so a logged-out visitor never reaches the session client, and a provided origin (an
// archive's entry) replaces the file under the same token and cache.
export function usePreviewBytes(item: DriveItem): UsePreviewBytesResult {
	const origin = usePreviewOrigin(item)
	const load = usePreviewFetch(item, {
		seed: getPreviewBytes,
		run: async ({ token, signal, cacheScope }) =>
			await loadOriginBytes(origin, token, { cap: originSize(origin), scope: cacheScope, signal })
	})

	return load.status === "success" ? { status: "success", bytes: load.value, refetch: load.refetch } : load
}
