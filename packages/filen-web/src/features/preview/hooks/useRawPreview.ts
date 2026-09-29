import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { getRawPreview, previewCacheEpoch, setRawPreview } from "@/features/preview/lib/previewCache"
import { type RawPreviewResult } from "@/features/preview/lib/rawPreview.logic"
import { type PreviewLoad, usePreviewFetch } from "@/features/preview/hooks/usePreviewFetch"

export type UseRawPreviewResult =
	Exclude<PreviewLoad<RawPreviewResult>, { status: "success" }> | { status: "success"; preview: RawPreviewResult; refetch: () => void }

// A RAW's embedded preview instead of the file's own bytes, with usePreviewFetch's lifecycle and the same
// authed/anon seam and session cache as usePreviewBytes.
export function useRawPreview(item: DriveItem): UseRawPreviewResult {
	const load = usePreviewFetch(item, {
		seed: getRawPreview,
		run: async ({ token, accessMode, cacheScope, uuid }) => {
			const epoch = previewCacheEpoch()
			const cached = getRawPreview(cacheScope, uuid)

			if (cached !== undefined) {
				return cached
			}

			const file = narrowToAnyFile(item)
			const preview = await runOp<RawPreviewResult>(
				accessMode === "anon" ? sdkApi.fetchLinkedRawPreviewAnon(file, token) : sdkApi.fetchRawPreview(file, token)
			)

			setRawPreview(cacheScope, uuid, preview, epoch)

			return preview
		}
	})

	return load.status === "success" ? { status: "success", preview: load.value, refetch: load.refetch } : load
}
