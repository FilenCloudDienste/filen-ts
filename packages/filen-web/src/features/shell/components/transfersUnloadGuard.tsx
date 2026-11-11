import { useEffect } from "react"
import { useHasActivePageTransfers } from "@/features/transfers/store/useTransfersStore"
import { holdUnload } from "@/lib/unloadGuard"

// Closing or reloading the tab stops every running upload, download and drive job (copy, compress,
// extract; the SDK runs in this tab's worker), so the browser's leave-page prompt is armed while any is
// active. The desktop app's native transfers run outside the page and do not count. Mounted at the root, since a
// transfer can outlive the route that started it. Renders nothing.
export function TransfersUnloadGuard() {
	const active = useHasActivePageTransfers()

	useEffect(() => (active ? holdUnload() : undefined), [active])

	return null
}
