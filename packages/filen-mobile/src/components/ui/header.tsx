import { memo, useMemo } from "@/lib/memo"
import { useResolveClassNames } from "uniwind"
import { Stack } from "expo-router"
import type { BlurEffectTypes, SearchBarProps } from "react-native-screens"
import { isLiquidGlassAvailable, View } from "@/components/ui/view"
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
		const liquidGlassAvailable = isLiquidGlassAvailable()

		return (
			<View
				className={cn(
					"flex-row items-center justify-center bg-transparent",
					Platform.select({
						ios: liquidGlassAvailable ? "h-9 min-w-9" : "",
						default: ""
					}),
					items && items.length >= 2 ? "gap-4" : "",
					Platform.select({
						ios: items && items.length >= 2 && liquidGlassAvailable ? "px-2" : "",
						default: ""
					}),
					isLeft && (Platform.OS === "android" || !liquidGlassAvailable) ? "pr-4" : "",
					isRight && (Platform.OS === "android" || !liquidGlassAvailable) ? "pl-4" : "",
					className
				)}
			>
				{items?.map((item, index) => {
					switch (item.type) {
						case "text": {
							return (
								<Text
									key={index}
									{...item.props}
								/>
							)
						}

						case "button": {
							return (
								<PressableScale
									key={index}
									{...item.props}
									className={
										!item.icon && Platform.OS === "ios" && liquidGlassAvailable
											? cn("px-2", item.props?.className)
											: item.props?.className
									}
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
										className={
											!item.icon && Platform.OS === "ios" && liquidGlassAvailable
												? cn("px-2", item.props?.className)
												: item.props?.className
										}
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
									className="bg-transparent"
									key={index}
								>
									{item.children}
								</View>
							)
						}

						case "loader": {
							return (
								<ActivityIndicator
									key={index}
									{...item.props}
								/>
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
		backTitle,
		shadowVisible,
		transparent,
		blurEffect,
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
		backTitle?: string
		shadowVisible?: boolean
		transparent?: boolean
		blurEffect?: BlurEffectTypes
		searchBarOptions?: SearchBarProps
		leftItems?: HeaderItem[] | (() => HeaderItem[] | null | undefined | void)
		rightItems?: HeaderItem[] | (() => HeaderItem[] | null | undefined | void)
		backgroundColor?: string
	}) => {
		const bgBackground = useResolveClassNames("bg-background")
		const textForeground = useResolveClassNames("text-foreground")
		const liquidGlassAvailable = useMemo(() => isLiquidGlassAvailable(), [])

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
					headerBlurEffect: !liquidGlassAvailable && Platform.OS === "ios" ? (blurEffect ?? "systemChromeMaterial") : undefined,
					headerBackVisible: backVisible,
					headerTransparent: transparent,
					headerBackTitle: backTitle,
					headerLargeTitle: largeTitle,
					headerTitleAlign: "left",
					headerStyle: backgroundColor
						? { backgroundColor }
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
