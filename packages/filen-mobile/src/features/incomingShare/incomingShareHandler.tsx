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
