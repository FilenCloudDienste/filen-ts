import events from "@/lib/events"
import { useEffect, memo } from "react"
import { runEffect } from "@filen/utils"
import { ActionSheetProvider as ExpoActionSheetProvider, useActionSheet } from "@expo/react-native-action-sheet"
import { useResolveClassNames, useUniwind } from "uniwind"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type { ViewStyle } from "react-native"

export type ShowActionSheetOptions = {
	buttons: {
		title: string
		destructive?: boolean
		cancel?: boolean
		onPress?: () => void
	}[]
	containerStyle?: ViewStyle
	userInterfaceStyle?: "light" | "dark"
}

export const ActionSheetProviderInner = memo(({ children }: { children: React.ReactNode }) => {
	const { showActionSheetWithOptions } = useActionSheet()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const { theme } = useUniwind()
	const insets = useSafeAreaInsets()

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const showActionSheetListener = events.subscribe("showActionSheet", options => {
				const buttons = options.buttons.map(button => button.title)
				const destructiveButtonIndex = options.buttons
					.map((button, index) => (button.destructive ? index : -1))
					.filter(index => index !== -1)
				const cancelButtonIndex = options.buttons
					.map((button, index) => (button.cancel ? index : -1))
					.filter(index => index !== -1)
					.at(-1)
				const buttonActions = options.buttons.map(button => button.onPress)

				showActionSheetWithOptions(
					{
						options: buttons,
						cancelButtonIndex,
						destructiveButtonIndex,
						containerStyle: options.containerStyle ?? {
							backgroundColor: bgBackgroundSecondary.backgroundColor,
							borderTopLeftRadius: 16,
							borderTopRightRadius: 16,
							paddingBottom: insets.bottom,
							paddingLeft: insets.left,
							paddingRight: insets.right
						},
						userInterfaceStyle: options.userInterfaceStyle ?? (theme === "dark" ? "dark" : "light")
					},
					(selectedIndex?: number) => {
						const action = buttonActions[selectedIndex ?? -1]

						if (action) {
							action()
						}
					}
				)
			})

			defer(() => {
				showActionSheetListener.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [showActionSheetWithOptions, bgBackgroundSecondary.backgroundColor, theme, insets.bottom, insets.left, insets.right])

	return children
})

export const ActionSheetProvider = memo(({ children }: { children: React.ReactNode }) => {
	return (
		<ExpoActionSheetProvider>
			<ActionSheetProviderInner>{children}</ActionSheetProviderInner>
		</ExpoActionSheetProvider>
	)
})

export class ActionSheet {
	public async show(options: ShowActionSheetOptions) {
		events.emit("showActionSheet", options)
	}
}

export const actionSheet = new ActionSheet()

export default ActionSheetProvider
