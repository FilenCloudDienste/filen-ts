import { useResolveClassNames } from "uniwind"
import Header, { type HeaderItem, type HeaderSearch } from "@/components/ui/header"
import { Platform } from "react-native"

type HeaderItems = HeaderItem[] | (() => HeaderItem[] | null | undefined | void)

/**
 * Shared header for modal and nested screens on the secondary background.
 *
 * Encapsulates the platform-aware transparent/background colour setup and the
 * Android-native-back / iOS-close-or-back-button left-item pattern.
 *
 * Props:
 *   title            — passed straight through to <Header>
 *   icon             — "close" (default) for top-level modal screens,
 *                      "chevron-back-outline" for nested push screens
 *   onDismiss        — called when the iOS left button is pressed (each screen
 *                      passes its own exact closure so the navigation semantics
 *                      stay in the screen); without it there is no left button
 *   leftItems        — replaces the dismiss button when set (e.g. a
 *                      selection-mode clear button)
 *   rightItems       — optional, forwarded as-is to <Header>
 *   search           — optional, forwarded as-is to <Header>
 */
export function SettingsHeader({
	title,
	icon,
	onDismiss,
	leftItems,
	rightItems,
	search
}: {
	title: string
	icon?: "close" | "chevron-back-outline"
	onDismiss?: () => void
	leftItems?: HeaderItems
	rightItems?: HeaderItems
	search?: HeaderSearch
}) {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<Header
			title={title}
			transparent={Platform.OS === "ios"}
			shadowVisible={false}
			backVisible={Platform.OS === "android"}
			backgroundColor={Platform.select({
				ios: undefined,
				default: bgBackgroundSecondary.backgroundColor as string
			})}
			leftItems={
				leftItems ??
				(() => {
					if (Platform.OS === "android" || !onDismiss) {
						return null
					}

					return [
						{
							type: "button",
							icon: {
								name: icon ?? "close",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: onDismiss
							}
						}
					]
				})
			}
			rightItems={rightItems}
			search={search}
		/>
	)
}

export default SettingsHeader
