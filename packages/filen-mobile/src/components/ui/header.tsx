import { useResolveClassNames } from "uniwind"
import { Stack } from "expo-router"
import type { SearchBarProps } from "react-native-screens"
import { View } from "@/components/ui/view"
import { cn } from "@filen/shared"
import { Platform, ActivityIndicator, type ColorValue } from "react-native"
import Menu from "@/components/ui/menu"
import Ionicons from "@expo/vector-icons/Ionicons"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"

export type HeaderItem =
	| {
			type: "menu"
			props?: Omit<React.ComponentProps<typeof Menu>, "children">
			text?: React.ComponentProps<typeof Text>
			icon?: React.ComponentProps<typeof Ionicons>
			triggerProps?: React.ComponentProps<typeof PressableScale>
	  }
	| {
			type: "button"
			props?: React.ComponentProps<typeof PressableScale>
			text?: React.ComponentProps<typeof Text>
			icon?: React.ComponentProps<typeof Ionicons>
	  }
	| {
			type: "loader"
			props?: React.ComponentProps<typeof ActivityIndicator>
	  }

const HeaderItemButton = ({
	icon,
	text,
	className,
	...props
}: React.ComponentProps<typeof PressableScale> & {
	icon?: React.ComponentProps<typeof Ionicons>
	text?: React.ComponentProps<typeof Text>
}) => {
	return (
		<PressableScale
			{...props}
			className={cn(
				"size-9 items-center justify-center rounded-full",
				!icon && Platform.OS === "ios" ? cn("px-2", className) : className
			)}
		>
			{icon ? (
				<Ionicons
					{...icon}
					size={24}
				/>
			) : (
				<Text {...text} />
			)}
		</PressableScale>
	)
}

export const HeaderLeftRightWrapper = ({
	isLeft,
	isRight,
	items
}: {
	isLeft?: boolean
	isRight?: boolean
	items?: HeaderItem[]
}) => {
	return (
		<View
			className={cn(
				"flex-row items-center justify-center bg-transparent",
				Platform.select({
					ios: "h-9 min-w-9",
					default: ""
				}),
				items && items.length >= 2 ? "gap-2" : "",
				Platform.select({
					ios: items && items.length >= 2 ? "px-2" : "",
					default: ""
				}),
				isLeft && Platform.OS === "android" ? "pr-4" : "",
				isRight && Platform.OS === "android" ? "pl-4" : ""
			)}
		>
			{items?.map((item, index) => {
				switch (item.type) {
					case "button": {
						return (
							<HeaderItemButton
								key={index}
								{...item.props}
								icon={item.icon}
								text={item.text}
							/>
						)
					}

					case "menu": {
						return (
							<Menu
								key={index}
								{...item.props}
								type="dropdown"
							>
								<HeaderItemButton
									{...item.triggerProps}
									icon={item.icon}
									text={item.text}
								/>
							</Menu>
						)
					}

					case "loader": {
						return (
							<View
								className="size-9 flex-row items-center justify-center rounded-full bg-transparent"
								key={index}
							>
								<ActivityIndicator {...item.props} />
							</View>
						)
					}

					default: {
						return null
					}
				}
			})}
		</View>
	)
}

export const Header = ({
	title,
	backVisible,
	shadowVisible,
	transparent,
	searchBarOptions,
	leftItems,
	rightItems,
	backgroundColor
}: {
	title: string | React.ReactNode | ((props: { children: string; tintColor?: ColorValue | undefined }) => React.ReactNode)
	backVisible?: boolean
	shadowVisible?: boolean
	transparent?: boolean
	searchBarOptions?: SearchBarProps
	leftItems?: HeaderItem[] | (() => HeaderItem[] | null | undefined | void)
	rightItems?: HeaderItem[] | (() => HeaderItem[] | null | undefined | void)
	backgroundColor?: string
}) => {
	const bgBackground = useResolveClassNames("bg-background")
	const textForeground = useResolveClassNames("text-foreground")

	const headerRightItems = (() => {
		const items = typeof rightItems === "function" ? rightItems() : rightItems

		if (!items || items.length === 0) {
			return []
		}

		return items
	})()

	const headerLeftItems = (() => {
		const items = typeof leftItems === "function" ? leftItems() : leftItems

		if (!items || items.length === 0) {
			return []
		}

		return items
	})()

	return (
		<Stack.Screen
			options={{
				headerTitle: typeof title === "function" ? props => title(props) : typeof title === "string" ? title : () => title,
				headerShown: true,
				headerShadowVisible: shadowVisible,
				headerBackVisible: backVisible,
				headerTransparent: transparent,
				headerBackTitle: "",
				headerBackButtonDisplayMode: "minimal",
				headerTitleAlign: "left",
				headerStyle: backgroundColor
					? {
							backgroundColor
						}
					: transparent
						? undefined
						: {
								backgroundColor: bgBackground.backgroundColor as string
							},
				headerTitleStyle: {
					color: textForeground.color as string
				},
				headerTintColor: textForeground.color as string,
				headerSearchBarOptions: searchBarOptions,
				headerRight:
					headerRightItems.length > 0
						? () => (
								<HeaderLeftRightWrapper
									isRight={true}
									items={headerRightItems}
								/>
							)
						: undefined,
				headerLeft:
					headerLeftItems.length > 0
						? () => (
								<HeaderLeftRightWrapper
									isLeft={true}
									items={headerLeftItems}
								/>
							)
						: undefined
			}}
		/>
	)
}

export default Header
