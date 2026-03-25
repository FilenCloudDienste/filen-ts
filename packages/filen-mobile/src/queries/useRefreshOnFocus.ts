import { useRef, useCallback } from "react"
import { useFocusEffect } from "@react-navigation/native"
import type { UseQueryResult } from "@tanstack/react-query"

export default function useRefreshOnFocus({
	isEnabled,
	refetch
}: {
	isEnabled: UseQueryResult["isEnabled"]
	refetch: UseQueryResult["refetch"]
}): void {
	const enabledRef = useRef<boolean>(false)

	useFocusEffect(
		useCallback(() => {
			if (!isEnabled) {
				return
			}

			if (enabledRef.current) {
				console.log("[useRefreshOnFocus] Refetching on focus")

				refetch().catch(() => {})
			} else {
				enabledRef.current = true
			}
		}, [isEnabled, refetch])
	)
}
