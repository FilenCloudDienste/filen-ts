import { useCallback } from "react"
import { useFocusEffect } from "expo-router"
import useDismissStack from "@/hooks/useDismissStack"

const DismissStack = () => {
	const dismiss = useDismissStack()

	useFocusEffect(
		useCallback(() => {
			dismiss()
		}, [dismiss])
	)

	return null
}

export default DismissStack
