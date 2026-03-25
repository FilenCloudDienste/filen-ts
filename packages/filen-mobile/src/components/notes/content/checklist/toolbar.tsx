import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { KeyboardStickyView, CrossGlassContainerView } from "@/components/ui/view"
import { useKeyboardState, KeyboardController } from "react-native-keyboard-controller"
import { useResolveClassNames } from "uniwind"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { PressableScale } from "@/components/ui/pressables"
import alerts from "@/lib/alerts"
import { memo, useCallback } from "react"

const Toolbar = memo(() => {
	const keyboardState = useKeyboardState()
	const textPrimary = useResolveClassNames("text-primary")

	const onPress = useCallback(() => {
		if (!keyboardState.isVisible) {
			return
		}

		KeyboardController.dismiss().catch(err => {
			console.error(err)
			alerts.error(err)
		})
	}, [keyboardState.isVisible])

	const insets = useSafeAreaInsets()

	if (!keyboardState.isVisible) {
		return null
	}

	return (
		<KeyboardStickyView>
			<AnimatedView
				entering={FadeIn}
				exiting={FadeOut}
				className="absolute z-50 bg-transparent"
				style={{
					bottom: 16,
					right: 16 + insets.right
				}}
			>
				<CrossGlassContainerView className="items-center justify-center rounded-full size-11">
					<PressableScale
						rippleColor="transparent"
						onPress={onPress}
						hitSlop={32}
					>
						<Ionicons
							name="checkmark"
							size={24}
							color={textPrimary.color}
						/>
					</PressableScale>
				</CrossGlassContainerView>
			</AnimatedView>
		</KeyboardStickyView>
	)
})

export default Toolbar
