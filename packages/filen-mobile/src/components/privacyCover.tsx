import { AppState, Platform } from "react-native"
import { FullWindowOverlay } from "react-native-screens"
import { useEffect, useState } from "react"
import { AnimatedView } from "@/components/ui/animated"
import { FadeOut } from "react-native-reanimated"
import View from "@/components/ui/view"
import { runEffect } from "@filen/utils"

const COVER_CLASSES = "absolute top-0 left-0 right-0 bottom-0 z-10001 w-full h-full bg-background"

function Parent({ children }: { children: React.ReactNode }) {
	if (Platform.OS === "ios") {
		return <FullWindowOverlay>{children}</FullWindowOverlay>
	}

	return <View className="absolute top-0 left-0 right-0 bottom-0 z-10001 w-full h-full">{children}</View>
}

function PrivacyCover() {
	const [visible, setVisible] = useState<boolean>(() => AppState.currentState !== "active")

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const appStateListener = AppState.addEventListener("change", nextAppState => {
				setVisible(nextAppState !== "active")
			})

			defer(() => {
				appStateListener.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

	if (!visible) {
		return null
	}

	return (
		<Parent>
			<AnimatedView
				className={COVER_CLASSES}
				exiting={FadeOut}
			/>
		</Parent>
	)
}

export default PrivacyCover
