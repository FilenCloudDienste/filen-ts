import { useHeaderHeight as useHeaderHeightFn } from "@react-navigation/elements"
import { useMemo } from "@/lib/memo"
import { useSecureStore } from "@/lib/secureStore"
import { useEffect, useRef } from "react"

export default function useHeaderHeight(cacheKey?: string) {
	const headerHeight = useHeaderHeightFn()
	const [cachedHeaderHeight, setCachedHeaderHeight] = useSecureStore<number | null>(`useHeaderHeight:${cacheKey ?? "default"}`, null)
	const renderCountRef = useRef<number>(0)

	const height = useMemo(() => {
		if (cacheKey && cachedHeaderHeight !== null) {
			return cachedHeaderHeight
		}

		return headerHeight
	}, [headerHeight, cachedHeaderHeight, cacheKey])

	useEffect(() => {
		if (cacheKey && cachedHeaderHeight === headerHeight) {
			return
		}

		if (renderCountRef.current === 0) {
			renderCountRef.current += 1

			return
		}

		setCachedHeaderHeight(headerHeight)
	}, [headerHeight, setCachedHeaderHeight, cacheKey, cachedHeaderHeight])

	return height
}
