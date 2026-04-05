import { memo, useEffect, useRef } from "react"
import useIncomingShareStore from "@/stores/useIncomingShare.store"
import { useShallow } from "zustand/shallow"
import { router, useNavigation, usePathname } from "expo-router"

const IncomingShareHandler = memo(() => {
	const process = useIncomingShareStore(useShallow(state => state.process))
	const { getId } = useNavigation()
	const navigationId = getId()
	const pathname = usePathname()
	const isProcessingRef = useRef<boolean>(false)

	useEffect(() => {
		if (process && !isProcessingRef.current && !navigationId?.startsWith("/incomingShare") && !pathname.startsWith("/incomingShare")) {
			isProcessingRef.current = true

			router.push("/incomingShare")

			setTimeout(() => {
				isProcessingRef.current = false
			}, 1000)
		}
	}, [process, navigationId, pathname])

	return null
})

export default IncomingShareHandler
