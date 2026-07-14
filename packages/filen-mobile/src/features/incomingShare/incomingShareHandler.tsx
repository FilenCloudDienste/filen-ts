import { useEffect, useRef } from "react"
import useIncomingShareStore from "@/features/incomingShare/store/useIncomingShare.store"
import { useShallow } from "zustand/shallow"
import { useNavigation, usePathname } from "expo-router"
import { router } from "@/lib/router"

const IncomingShareHandler = () => {
	const process = useIncomingShareStore(useShallow(state => state.process))
	const { getId } = useNavigation()
	const navigationId = getId()
	const pathname = usePathname()
	const isProcessingRef = useRef<boolean>(false)

	useEffect(() => {
		if (!process) {
			isProcessingRef.current = false

			return
		}

		// Wait for the app to settle onto its start route before pushing. On a cold-boot share the app is
		// briefly on the transient index route ("/"), which immediately redirects to the start screen — a
		// push issued during that window is discarded by the redirect (and latching isProcessingRef here
		// would then permanently skip the real, post-settle push). This effect re-runs when pathname
		// updates, so we push once we're on a real route — where the modal also has a stack to close to.
		if (pathname === "/") {
			return
		}

		if (pathname.startsWith("/incomingShare") || navigationId?.startsWith("/incomingShare")) {
			return
		}

		if (isProcessingRef.current) {
			return
		}

		isProcessingRef.current = true

		router.push("/incomingShare")
	}, [process, navigationId, pathname])

	return null
}

export default IncomingShareHandler
