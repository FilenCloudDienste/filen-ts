import { memo, useMemo } from "@/lib/memo"
import { useResolveClassNames } from "uniwind"
import { Stack } from "expo-router"
import type { SearchBarProps } from "react-native-screens"
import { View } from "@/components/ui/view"
import { cn } from "@filen/utils"
import { Platform, ActivityIndicator } from "react-native"
import Menu from "@/components/ui/menu"
import Ionicons from "@expo/vector-icons/Ionicons"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"

export type HeaderItem =
	| {
			type: "text"
			props?: React.ComponentProps<typeof Text>
	  }
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
			type: "custom"
			children: React.ReactNode
	  }
	| {
			type: "loader"
			props?: React.ComponentProps<typeof ActivityIndicator>
	  }

export const ICON_SIZE = Platform.select({
	ios: 24,
	default: 24
})

export const HeaderLeftRightWrapper = memo(
	({ className, isLeft, isRight, items }: { className?: string; isLeft?: boolean; isRight?: boolean; items?: HeaderItem[] }) => {
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
					isRight && Platform.OS === "android" ? "pl-4" : "",
					className
				)}
			>
				{items?.map((item, index) => {
					switch (item.type) {
						case "text": {
							return (
								<View
									className="bg-transparent min-h-9 min-w-9 flex-row items-center"
									key={index}
								>
									<Text {...item.props} />
								</View>
							)
						}

						case "button": {
							return (
								<PressableScale
									key={index}
									{...item.props}
									className={cn(
										"size-9 items-center justify-center rounded-full",
										!item.icon && Platform.OS === "ios" ? cn("px-2", item.props?.className) : item.props?.className
									)}
								>
									{item.icon ? (
										<Ionicons
											{...item.icon}
											size={ICON_SIZE}
										/>
									) : (
										<Text {...item.text} />
									)}
								</PressableScale>
							)
						}

						case "menu": {
							return (
								<Menu
									key={index}
									{...item.props}
									type="dropdown"
								>
									<PressableScale
										{...item.triggerProps}
										className={cn(
											"size-9 items-center justify-center rounded-full",
											!item.icon && Platform.OS === "ios" ? cn("px-2", item.props?.className) : item.props?.className
										)}
									>
										{item.icon ? (
											<Ionicons
												{...item.icon}
												size={ICON_SIZE}
											/>
										) : (
											<Text {...item.text} />
										)}
									</PressableScale>
								</Menu>
							)
						}

						case "custom": {
							return (
								<View
									className="bg-transparent min-h-9 min-w-9 flex-row items-center"
									key={index}
								>
									{item.children}
								</View>
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
)

export const Header = memo(
	({
		title,
		shown,
		largeTitle,
		backVisible,
		shadowVisible,
		transparent,
		searchBarOptions,
		leftItems,
		rightItems,
		backgroundColor
	}: {
		title:
			| string
			| React.ReactNode
			| React.ReactElement
			| React.JSX.Element
			| ((props: { children: string; tintColor?: string | undefined }) => React.ReactNode | React.ReactElement | React.JSX.Element)
		shown?: boolean
		largeTitle?: boolean
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

		const headerRightItems = useMemo(() => {
			const items = typeof rightItems === "function" ? rightItems() : rightItems

			if (!items || items.length === 0) {
				return []
			}

			return items
		}, [rightItems])

		const headerLeftItems = useMemo(() => {
			const items = typeof leftItems === "function" ? leftItems() : leftItems

			if (!items || items.length === 0) {
				return []
			}

			return items
		}, [leftItems])

		return (
			<Stack.Screen
				options={{
					headerTitle: typeof title === "function" ? props => title(props) : typeof title === "string" ? title : () => title,
					headerShown: shown ?? true,
					headerShadowVisible: shadowVisible,
					headerBlurEffect: undefined,
					headerBackVisible: backVisible,
					headerTransparent: transparent,
					headerBackTitle: "",
					headerBackButtonDisplayMode: "minimal",
					headerLargeTitle: largeTitle,
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
)

export default Header
