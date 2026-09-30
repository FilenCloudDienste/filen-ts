import { useNavigation } from "expo-router"

/** Returns a callback that closes the whole modal stack the calling screen lives in. */
export default function useDismissStack(): () => void {
	const navigation = useNavigation()

	return () => {
		navigation.getParent()?.goBack()
	}
}
