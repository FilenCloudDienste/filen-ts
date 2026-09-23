import { useEffect, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { usePreviewAccessMode, usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { getRawPreview, previewCacheEpoch, setRawPreview } from "@/features/preview/lib/previewCache"
import { type RawPreviewResult } from "@/features/preview/lib/rawPreview.logic"

export type UseRawPreviewResult =
	| { status: "pending"; refetch: () => void }
	| { status: "success"; preview: RawPreviewResult; refetch: () => void }
	| { status: "error"; dto: ErrorDTO; refetch: () => void }

// usePreviewBytes's lifecycle (fresh token per load, cancel on unmount/item change, reloadToken
// retry, the same authed/anon seam, the same session cache) for a RAW's embedded preview instead of the
// file's own bytes.
export function useRawPreview(item: DriveItem): UseRawPreviewResult {
	const accessMode = usePreviewAccessMode()
	const cacheScope = usePreviewCacheScope()
	const [result, setResult] = useState<
		{ status: "pending" } | { status: "success"; preview: RawPreviewResult } | { status: "error"; dto: ErrorDTO }
	>(() => {
		const preview = getRawPreview(cacheScope, item.data.uuid)

		return preview === undefined ? { status: "pending" } : { status: "success", preview }
	})
	const [reloadToken, setReloadToken] = useState(0)

	useEffect(() => {
		let live = true
		const token = crypto.randomUUID()
		const epoch = previewCacheEpoch()

		async function fetchPreview(): Promise<RawPreviewResult> {
			const file = narrowToAnyFile(item)
			const preview = await runOp<RawPreviewResult>(
				accessMode === "anon" ? sdkApi.fetchLinkedRawPreviewAnon(file, token) : sdkApi.fetchRawPreview(file, token)
			)

			setRawPreview(cacheScope, item.data.uuid, preview, epoch)

			return preview
		}

		async function load(): Promise<void> {
			try {
				const preview = getRawPreview(cacheScope, item.data.uuid) ?? (await fetchPreview())

				if (live) {
					setResult(prev => (prev.status === "success" && prev.preview === preview ? prev : { status: "success", preview }))
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
			void sdkApi.cancelPreviewDownload(token)
		}
	}, [item, reloadToken, accessMode, cacheScope])

	function refetch(): void {
		setResult({ status: "pending" })
		setReloadToken(prev => prev + 1)
	}

	return { ...result, refetch }
}
