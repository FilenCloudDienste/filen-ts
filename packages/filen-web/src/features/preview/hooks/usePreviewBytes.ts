import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { getPreviewBytes, loadPreviewBytes } from "@/features/preview/lib/previewCache"
import { usePreviewByteSource } from "@/features/preview/lib/accessMode"
import { type PreviewLoad, usePreviewFetch } from "@/features/preview/hooks/usePreviewFetch"

export type UsePreviewBytesResult =
	Exclude<PreviewLoad<Uint8Array>, { status: "success" }> | { status: "success"; bytes: Uint8Array; refetch: () => void }

// Loads one file's whole decrypted buffer for the preview overlay, with usePreviewFetch's lifecycle.
//
// A buffer already loaded this session (previewCache.ts) is served without a download: the initial
// state reads it so a revisited slot renders on its first paint, and only a completed load is stored,
// so a failed or cancelled one is fetched again next time. A load of the same file already in flight
// is joined rather than repeated; this hook's token only ever cancels a fetch it started itself.
export function usePreviewBytes(item: DriveItem): UsePreviewBytesResult {
	const source = usePreviewByteSource()
	const load = usePreviewFetch(item, {
		seed: getPreviewBytes,
		// ★ The single byte-source seam: an "anon" ambient mode (the public-link routes) routes the whole
		// buffer through the UNAUTHENTICATED linked-file worker method instead of the authed one, so a
		// logged-out visitor never reaches requireClient. The authed app leaves this at "authed" and its
		// path is byte-for-byte unchanged. Both methods share the same previewAborts token registry, so the
		// cancel-on-unmount reaches an anon read with no change of its own. A byte source (an archive's
		// entry) replaces both, under the same token.
		run: async ({ token, signal, accessMode, cacheScope, uuid }) => {
			const file = narrowToAnyFile(item)

			return await loadPreviewBytes(
				cacheScope,
				uuid,
				Number(file.size),
				() =>
					runOp(
						source !== null
							? source(token)
							: accessMode === "anon"
								? sdkApi.downloadLinkedFileBytesAnon(file, token)
								: sdkApi.downloadFileBytes(file, token)
					),
				{
					signal
				}
			)
		}
	})

	return load.status === "success" ? { status: "success", bytes: load.value, refetch: load.refetch } : load
}
