import events from "@/lib/events"
import { useEffect, useRef } from "react"
import { runEffect } from "@filen/utils"
import { ActionSheetProvider as ExpoActionSheetProvider, useActionSheet } from "@expo/react-native-action-sheet"
import { useResolveClassNames, useUniwind } from "uniwind"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { BackHandler, type ViewStyle, Platform } from "react-native"

export type ShowActionSheetOptions = {
	// Optional sheet header. Rendered with the already-wired titleTextStyle. Used e.g. by the
	// Android sort-direction sheet to show which field the Ascending/Descending choice applies to.
	title?: string
	buttons: {
		title: string
		destructive?: boolean
		cancel?: boolean
		disabled?: boolean
		onPress?: () => void
	}[]
	containerStyle?: ViewStyle
	userInterfaceStyle?: "light" | "dark"
}

const ActionSheetProviderInner = ({ children }: { children: React.ReactNode }) => {
	const { showActionSheetWithOptions } = useActionSheet()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const { theme } = useUniwind()
	const insets = useSafeAreaInsets()
	const visibleRef = useRef<boolean>(false)
	const cancelActionRef = useRef<(() => void) | undefined>(undefined)

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
				if (!visibleRef.current) {
					return false
				}

				const action = cancelActionRef.current

				visibleRef.current = false
				cancelActionRef.current = undefined

				if (action) {
					action()
				}

				return true
			})

			defer(() => {
				subscription.remove()
			})
		})

		return () => {
			cleanup()
		}
	}, [])

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
				const disabledButtonIndices = options.buttons
					.map((button, index) => (button.disabled ? index : -1))
					.filter(index => index !== -1)
				const disabledSet = new Set<number>(disabledButtonIndices)
				const buttonActions = options.buttons.map(button => button.onPress)

				visibleRef.current = true
				cancelActionRef.current = cancelButtonIndex !== undefined ? buttonActions[cancelButtonIndex] : undefined

				showActionSheetWithOptions(
					{
						options: buttons,
						title: Platform.OS === "android" ? undefined : options.title,
						cancelButtonIndex,
						destructiveButtonIndex,
						disabledButtonIndices,
						containerStyle: options.containerStyle ?? {
							backgroundColor: bgBackgroundSecondary.backgroundColor,
							borderTopLeftRadius: 16,
							borderTopRightRadius: 16,
							paddingBottom: insets.bottom,
							paddingLeft: insets.left,
							paddingRight: insets.right,
							paddingTop: insets.top
						},
						textStyle: {
							color: textForeground.color
						},
						titleTextStyle: {
							color: textForeground.color
						},
						messageTextStyle: {
							color: textMutedForeground.color
						},
						userInterfaceStyle: options.userInterfaceStyle ?? (theme === "dark" ? "dark" : "light"),
						useModal: false
					},
					(selectedIndex?: number) => {
						const wasVisible = visibleRef.current

						visibleRef.current = false
						cancelActionRef.current = undefined

						if (!wasVisible) {
							return
						}

						if (selectedIndex !== undefined && disabledSet.has(selectedIndex)) {
							// Belt-and-suspenders against any platform where
							// disabledButtonIndices doesn't visually disable.
							return
						}

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
	}, [
		showActionSheetWithOptions,
		bgBackgroundSecondary.backgroundColor,
		theme,
		insets.bottom,
		insets.left,
		insets.right,
		insets.top,
		textForeground.color,
		textMutedForeground.color
	])

	return children
}

export const ActionSheetProvider = ({ children }: { children: React.ReactNode }) => {
	return (
		<ExpoActionSheetProvider>
			<ActionSheetProviderInner>{children}</ActionSheetProviderInner>
		</ExpoActionSheetProvider>
	)
}

// Thin façade over the actionSheet event channel (no instance state). The provider above
// listens for "showActionSheet" and renders the native sheet.
export const actionSheet = {
	async show(options: ShowActionSheetOptions) {
		events.emit("showActionSheet", options)
	}
}

export default ActionSheetProvider
