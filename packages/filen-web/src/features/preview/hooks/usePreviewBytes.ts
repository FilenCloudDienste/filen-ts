import { useEffect, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"

export type UsePreviewBytesResult = { status: "pending" } | { status: "success"; bytes: Uint8Array } | { status: "error"; dto: ErrorDTO }

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
export function usePreviewBytes(item: DriveItem): UsePreviewBytesResult {
	const [result, setResult] = useState<UsePreviewBytesResult>({ status: "pending" })

	useEffect(() => {
		let live = true
		const token = crypto.randomUUID()

		async function load(): Promise<void> {
			try {
				const file = narrowToAnyFile(item)
				const bytes = await runOp(sdkApi.downloadFileBytes(file, token))

				if (live) {
					setResult({ status: "success", bytes })
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
	}, [item])

	return result
}
