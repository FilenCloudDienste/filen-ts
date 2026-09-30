import { useResolveClassNames } from "uniwind"
import { Stack } from "expo-router"
import { View } from "@/components/ui/view"
import { cn } from "@filen/shared"
import { Platform, ActivityIndicator, type ColorValue } from "react-native"
import Menu, { type MenuButton } from "@/components/ui/menu"
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
	// Plain-literal variants rather than builder functions: the React Compiler assumes an unknown call mutates
	// its arguments, which would un-memoize every button pushed into `buttons`.
	| {
			type: "ellipsisMenu"
			buttons: MenuButton[]
			triggerProps?: React.ComponentProps<typeof PressableScale>
	  }
	| {
			type: "clearSelection"
			onPress: () => void
	  }

export type HeaderSearch = {
	placeholder: string
	onChangeText: (query: string) => void
}

const ELLIPSIS_ICON = {
	name: "ellipsis-horizontal"
} satisfies React.ComponentProps<typeof Ionicons>

const CLEAR_SELECTION_ICON = {
	name: "close-outline"
} satisfies React.ComponentProps<typeof Ionicons>

const HeaderItemButton = ({
	icon,
	iconColor,
	text,
	className,
	...props
}: React.ComponentProps<typeof PressableScale> & {
	icon?: React.ComponentProps<typeof Ionicons>
	iconColor: ColorValue | undefined
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
					color={icon.color ?? iconColor}
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
	items,
	iconColor
}: {
	isLeft?: boolean
	isRight?: boolean
	items?: HeaderItem[]
	iconColor: ColorValue | undefined
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
								iconColor={iconColor}
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
									iconColor={iconColor}
									text={item.text}
								/>
							</Menu>
						)
					}

					case "ellipsisMenu": {
						return (
							<Menu
								key={index}
								type="dropdown"
								hitSlop={20}
								buttons={item.buttons}
							>
								<HeaderItemButton
									hitSlop={20}
									{...item.triggerProps}
									icon={ELLIPSIS_ICON}
									iconColor={iconColor}
								/>
							</Menu>
						)
					}

					case "clearSelection": {
						return (
							<HeaderItemButton
								key={index}
								onPress={item.onPress}
								icon={CLEAR_SELECTION_ICON}
								iconColor={iconColor}
							/>
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
	search,
	leftItems,
	rightItems,
	backgroundColor
}: {
	title: string | React.ReactNode | ((props: { children: string; tintColor?: ColorValue | undefined }) => React.ReactNode)
	backVisible?: boolean
	shadowVisible?: boolean
	transparent?: boolean
	search?: HeaderSearch
	leftItems?: HeaderItem[] | (() => HeaderItem[] | null | undefined | void)
	rightItems?: HeaderItem[] | (() => HeaderItem[] | null | undefined | void)
	backgroundColor?: string
}) => {
	const bgBackground = useResolveClassNames("bg-background")
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

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
				headerSearchBarOptions: search
					? {
							placement: "integratedButton",
							placeholder: search.placeholder,
							onChangeText: e => search.onChangeText(e.nativeEvent.text),
							onCancelButtonPress: () => search.onChangeText(""),
							onClose: () => search.onChangeText(""),
							onOpen: () => search.onChangeText(""),
							allowToolbarIntegration: false,
							headerIconColor: textForeground.color,
							textColor: textForeground.color,
							barTintColor: "transparent",
							tintColor: textForeground.color,
							hintTextColor: textMutedForeground.color,
							shouldShowHintSearchIcon: true,
							hideNavigationBar: false,
							hideWhenScrolling: false,
							inputType: "text"
						}
					: undefined,
				headerRight:
					headerRightItems.length > 0
						? () => (
								<HeaderLeftRightWrapper
									isRight={true}
									items={headerRightItems}
									iconColor={textForeground.color}
								/>
							)
						: undefined,
				headerLeft:
					headerLeftItems.length > 0
						? () => (
								<HeaderLeftRightWrapper
									isLeft={true}
									items={headerLeftItems}
									iconColor={textForeground.color}
								/>
							)
						: undefined
			}}
		/>
	)
}

export default Header
