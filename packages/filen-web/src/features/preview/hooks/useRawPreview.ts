import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { getRawPreview, previewCacheEpoch, setRawPreview } from "@/features/preview/lib/previewCache"
import { type RawPreviewResult } from "@/features/preview/lib/rawPreview.logic"
import { type PreviewLoad, usePreviewFetch } from "@/features/preview/hooks/usePreviewFetch"
import { useProvidedPreviewOrigin } from "@/features/preview/lib/accessMode"

export type UseRawPreviewResult =
	Exclude<PreviewLoad<RawPreviewResult>, { status: "success" }> | { status: "success"; preview: RawPreviewResult; refetch: () => void }

// A RAW's embedded preview instead of the file's own bytes, with usePreviewFetch's lifecycle and the same
// authed/anon seam and session cache as usePreviewBytes; an archive's entry through its provided origin.
export function useRawPreview(item: DriveItem): UseRawPreviewResult {
	const provided = useProvidedPreviewOrigin()
	const load = usePreviewFetch(item, {
		seed: getRawPreview,
		run: async ({ token, accessMode, cacheScope, uuid }) => {
			const epoch = previewCacheEpoch()
			const cached = getRawPreview(cacheScope, uuid)

			if (cached !== undefined) {
				return cached
			}

			// An archive's RAW entry: its embedded preview walked by range through the archive's reader.
			const preview = await runOp<RawPreviewResult>(
				provided !== null
					? sdkApi.fetchOriginRawPreview(provided, accessMode, token)
					: accessMode === "anon"
						? sdkApi.fetchLinkedRawPreviewAnon(narrowToAnyFile(item), token)
						: sdkApi.fetchRawPreview(narrowToAnyFile(item), token)
			)

			setRawPreview(cacheScope, uuid, preview, epoch)

			return preview
		}
	})

	return load.status === "success" ? { status: "success", preview: load.value, refetch: load.refetch } : load
}
