import { useResolveClassNames } from "uniwind"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Platform } from "react-native"

/**
 * Shared header used by all settings screens.
 *
 * Encapsulates the platform-aware transparent/background colour setup and the
 * Android-returns-null / iOS-close-or-back-button left-item pattern that is
 * repeated verbatim across every settings screen.
 *
 * Props:
 *   title       — passed straight through to <Header>
 *   icon        — "close" for top-level modal screens, "chevron-back-outline"
 *                 for nested push screens
 *   onDismiss   — called when the left button is pressed (each screen passes
 *                 its own exact closure so the navigation semantics stay in the
 *                 screen)
 *   rightItems  — optional, forwarded as-is to <Header> (e.g. personal.tsx
 *                 needs a save checkmark)
 */
export function SettingsHeader({
	title,
	icon,
	onDismiss,
	rightItems
}: {
	title: string
	icon: "close" | "chevron-back-outline"
	onDismiss: () => void
	rightItems?: HeaderItem[] | (() => HeaderItem[] | null | undefined | void)
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
			leftItems={() => {
				if (Platform.OS === "android") {
					return null
				}

				return [
					{
						type: "button",
						icon: {
							name: icon,
							color: textForeground.color,
							size: 20
						},
						props: {
							onPress: onDismiss
						}
					}
				]
			}}
			rightItems={rightItems}
		/>
	)
}

export default SettingsHeader
