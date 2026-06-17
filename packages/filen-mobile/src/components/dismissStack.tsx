import { useCallback } from "react"
import { useFocusEffect, useNavigation } from "expo-router"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"

const DismissStack = ({ error }: { error?: string }) => {
	const navigation = useNavigation()

	useFocusEffect(
		useCallback(() => {
			navigation.getParent()?.goBack()

			if (error) {
				logger.warn("nav", "DismissStack dismissed with error", { error })
				alerts.error(error)
			}
		}, [error, navigation])
	)

	return null
}

export default DismissStack
