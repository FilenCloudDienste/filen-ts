import { memo, useCallback } from "react"
import { router, useFocusEffect } from "expo-router"

const DismissStack = memo(() => {
	useFocusEffect(
		useCallback(() => {
			if (router.canDismiss()) {
				router.dismiss()
			}
		}, [])
	)

	return null
})

export default DismissStack
