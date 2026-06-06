import useAppStore from "@/stores/useApp.store"
import { useEffect } from "react"
import { usePathname } from "expo-router"

export const Pathname = () => {
	const pathname = usePathname()

	useEffect(() => {
		useAppStore.getState().setPathname(pathname)
	}, [pathname])

	return null
}

export default Pathname
