import { useCallback } from "react"
import { useFocusEffect, useNavigation } from "expo-router"

const DismissStack = () => {
	const navigation = useNavigation()

	useFocusEffect(
		useCallback(() => {
			navigation.getParent()?.goBack()
		}, [navigation])
	)

	return null
}

export default DismissStack
