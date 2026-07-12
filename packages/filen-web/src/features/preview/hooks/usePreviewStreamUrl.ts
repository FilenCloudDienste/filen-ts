import { useEffect, useState } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { previewStreamUrl } from "@/features/preview/lib/previewStream"

// `refetch` merged onto every variant — mirrors usePreviewBytes.ts's own identical shape/rationale.
// Re-registering (rather than just re-rendering) is the correct retry here: a mid-consumption failure
// means the PREVIOUS registration's stream is already broken, so a retry must mint a fresh one, not
// reuse the stale url a plain re-render would still be holding.
export type UsePreviewStreamUrlResult =
	| { status: "pending"; refetch: () => void }
	| { status: "success"; url: string; refetch: () => void }
	| { status: "error"; refetch: () => void }

// Registers `item` against the SW's inline-preview route once per mount and returns its fetchable
// same-origin URL — mirrors usePreviewBytes.ts's own shape/lifecycle (item-keyed effect, a `live`
// flag guarding a late resolution after unmount/item-change) but produces a stable src URL instead of
// a whole buffer. No cancellation message exists for a preview registration (unlike
// cancelPreviewDownload) — the SW's own bounded, oldest-evicted registry is the only cleanup, so the
// effect's cleanup only needs to stop a late setState, not undo any server-side state.
//
// A registration failure resolves "error", never a thrown rejection — every caller treats that as a
// signal to fall back to the buffered blob path, not a user-facing error (see imageViewer.tsx /
// mediaViewer.tsx's own onFallback wiring). An over-cap file (streamFailureAction "error") instead
// shows a labeled error state with Retry — `refetch` (see `reloadToken` below) is that retry's wiring,
// re-running this SAME registration rather than falling back to an unbounded buffered download.
export function usePreviewStreamUrl(item: DriveItem, name: string, contentType: string): UsePreviewStreamUrlResult {
	const [result, setResult] = useState<{ status: "pending" } | { status: "success"; url: string } | { status: "error" }>({
		status: "pending"
	})
	const [reloadToken, setReloadToken] = useState(0)

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
	}, [item, name, contentType, reloadToken])

	function refetch(): void {
		setResult({ status: "pending" })
		setReloadToken(prev => prev + 1)
	}

	return { ...result, refetch }
}
