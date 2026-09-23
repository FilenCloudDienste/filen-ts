import { useEffect, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { usePreviewAccessMode } from "@/features/preview/lib/accessMode"
import { type RawPreviewResult } from "@/features/preview/lib/rawPreview.logic"

export type UseRawPreviewResult =
	| { status: "pending"; refetch: () => void }
	| { status: "success"; preview: RawPreviewResult; refetch: () => void }
	| { status: "error"; dto: ErrorDTO; refetch: () => void }

// usePreviewBytes's lifecycle (fresh token per load, cancel on unmount/item change, reloadToken
// retry, the same authed/anon seam) for a RAW's embedded preview instead of the file's own bytes.
export function useRawPreview(item: DriveItem): UseRawPreviewResult {
	const accessMode = usePreviewAccessMode()
	const [result, setResult] = useState<
		{ status: "pending" } | { status: "success"; preview: RawPreviewResult } | { status: "error"; dto: ErrorDTO }
	>({
		status: "pending"
	})
	const [reloadToken, setReloadToken] = useState(0)

	useEffect(() => {
		let live = true
		const token = crypto.randomUUID()

		async function load(): Promise<void> {
			try {
				const file = narrowToAnyFile(item)
				const preview = await runOp<RawPreviewResult>(
					accessMode === "anon" ? sdkApi.fetchLinkedRawPreviewAnon(file, token) : sdkApi.fetchRawPreview(file, token)
				)

				if (live) {
					setResult({ status: "success", preview })
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
	}, [item, reloadToken, accessMode])

	function refetch(): void {
		setResult({ status: "pending" })
		setReloadToken(prev => prev + 1)
	}

	return { ...result, refetch }
}
