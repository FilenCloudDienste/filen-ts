import { useCallback } from "react"
import { useFocusEffect, useNavigation } from "expo-router"
import alerts from "@/lib/alerts"

const DismissStack = ({ error }: { error?: string }) => {
	const navigation = useNavigation()

	useFocusEffect(
		useCallback(() => {
			navigation.getParent()?.goBack()

			if (error) {
				alerts.error(error)
			}
		}, [error, navigation])
	)

	return null
}

export default DismissStack
