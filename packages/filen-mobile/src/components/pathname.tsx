import useAppStore from "@/stores/useApp.store"
import { useEffect, memo } from "react"
import { usePathname } from "expo-router"

export const Pathname = memo(() => {
	const pathname = usePathname()

	useEffect(() => {
		useAppStore.getState().setPathname(pathname)
	}, [pathname])

	return null
})

export default Pathname
