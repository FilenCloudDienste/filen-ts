import { useEffect } from "react"
import { Platform, AppState } from "react-native"
import { FullWindowOverlay } from "react-native-screens"
import { useSharedValue, useAnimatedStyle, type SharedValue } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import View from "@/components/ui/view"
import { usePrivacyScreenEnabled } from "@/features/settings/privacyScreen"
import { useSystemPresentationStore } from "@/lib/systemPresentation"

const COVER_CLASSES = "absolute top-0 left-0 right-0 bottom-0 z-10000 w-full h-full bg-background items-center justify-center"

// iOS: a FullWindowOverlay (window-level — sits ABOVE native pageSheet/formSheet modals, which the
// old expo-screen-capture blur did not, since it attached inside the RN root view).
// Android: a high-z absolute View (mirrors the biometric lock's Parent).
function Parent({ children }: { children: React.ReactNode }) {
	if (Platform.OS === "ios") {
		return <FullWindowOverlay>{children}</FullWindowOverlay>
	}

	return <View className="absolute top-0 left-0 right-0 bottom-0 z-10000 w-full h-full bg-background">{children}</View>
}

function setOpacityValue(opacity: SharedValue<number>, active: boolean, suppressed: boolean): void {
	opacity.value = !active && !suppressed ? 1 : 0
}

// React privacy cover. Redacts the app-switcher / recents preview whenever the app is not active, and
// is NOT shown while an in-app native presentation (picker / permission / Face ID) is on screen
// (systemPresentation). Replaces the native expo-screen-capture blur, which couldn't cover modals.
//
// Visibility is driven IMPERATIVELY off AppState (+ the presentation suppression) onto a reanimated
// shared value, rather than via React state, so it paints as early as possible against the OS
// snapshot. The overlay is kept mounted the whole time the setting is on (toggle only, no mount cost),
// and triggers on the "inactive" resign signal (earlier than "background").
function PrivacyCover() {
	const opacity = useSharedValue<number>(AppState.currentState === "active" ? 0 : 1)

	useEffect(() => {
		const apply = (): void => {
			const active = AppState.currentState === "active"
			const suppressed = useSystemPresentationStore.getState().activeCount > 0

			setOpacityValue(opacity, active, suppressed)
		}

		apply()

		const appStateSub = AppState.addEventListener("change", apply)
		const unsubPresentation = useSystemPresentationStore.subscribe(apply)

		return () => {
			appStateSub.remove()
			unsubPresentation()
		}
	}, [opacity])

	const animatedStyle = useAnimatedStyle(() => ({
		opacity: opacity.value
	}))

	return (
		<Parent>
			<AnimatedView
				className={COVER_CLASSES}
				style={animatedStyle}
				pointerEvents="none"
			/>
		</Parent>
	)
}

function PrivacyScreen() {
	const [enabled] = usePrivacyScreenEnabled()

	if (!enabled) {
		return null
	}

	return <PrivacyCover />
}

export default PrivacyScreen
