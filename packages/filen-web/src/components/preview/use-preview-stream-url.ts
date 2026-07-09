import { useEffect, useState } from "react"
import { type DriveItem } from "@/lib/drive/item"
import { narrowToAnyFile } from "@/lib/drive/download"
import { previewStreamUrl } from "@/lib/preview/preview-stream"

export type UsePreviewStreamUrlResult = { status: "pending" } | { status: "success"; url: string } | { status: "error" }

// Registers `item` against the SW's inline-preview route once per mount and returns its fetchable
// same-origin URL — mirrors use-preview-bytes.ts's own shape/lifecycle (item-keyed effect, a `live`
// flag guarding a late resolution after unmount/item-change) but produces a stable src URL instead of
// a whole buffer. No cancellation message exists for a preview registration (unlike
// cancelPreviewDownload) — the SW's own bounded, oldest-evicted registry is the only cleanup, so the
// effect's cleanup only needs to stop a late setState, not undo any server-side state.
//
// A registration failure resolves "error", never a thrown rejection — every caller treats that as a
// signal to fall back to the buffered blob path, not a user-facing error (see image-viewer.tsx /
// media-viewer.tsx's own onFallback wiring).
export function usePreviewStreamUrl(item: DriveItem, name: string, contentType: string): UsePreviewStreamUrlResult {
	const [result, setResult] = useState<UsePreviewStreamUrlResult>({ status: "pending" })

	useEffect(() => {
		let live = true

		async function register(): Promise<void> {
			try {
				const file = narrowToAnyFile(item)
				const url = await previewStreamUrl(file, name, contentType)

				if (live) {
					setResult({ status: "success", url })
				}
			} catch {
				if (live) {
					setResult({ status: "error" })
				}
			}
		}

		void register()

		return () => {
			live = false
		}
	}, [item, name, contentType])

	return result
}
