import { useEffect } from "react"
import { useHasActiveTransfers } from "@/features/transfers/store/useTransfersStore"
import { blockUnloadUnlessAllowed } from "@/lib/unloadGuard"

// Closing or reloading the tab stops every running upload, download and copy (the SDK runs in this
// tab's worker), so the browser's leave-page prompt is armed while any is active. Mounted at the root,
// since a transfer can outlive the route that started it. Renders nothing.
export function TransfersUnloadGuard() {
	const active = useHasActiveTransfers()

	useEffect(() => {
		if (!active) {
			return
		}

		window.addEventListener("beforeunload", blockUnloadUnlessAllowed)

		return () => {
			window.removeEventListener("beforeunload", blockUnloadUnlessAllowed)
		}
	}, [active])

	return null
}
