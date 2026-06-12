import View from "@/components/ui/view"
import { Switch } from "react-native"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { PressableOpacity } from "@/components/ui/pressables"
import { cn } from "@filen/utils"

export type Button = {
	icon?: React.ComponentProps<typeof Ionicons>["name"]
	iconColor?: string
	iconSize?: number
	// Custom leading slot (e.g. an image preview). Takes the icon's place;
	// when set, `icon` is ignored.
	leading?: React.ReactNode
	title: string
	titleClassName?: string
	subTitle?: string
	subTitleClassName?: string
	/**
	 * When set, limits the subtitle to this many lines (ellipsizeMode "tail").
	 * Omit (undefined) to preserve the default wrapping behaviour — intentional
	 * multi-line description strings should NOT pass this prop.
	 * Pass 1 for rows whose subtitle is user-provided data (email, nickname, …)
	 * where an unbounded wrap would produce uneven row heights.
	 */
	subTitleNumberOfLines?: number
	badge?: string | React.ReactNode
	badgeColor?: string
	onPress?: () => void
	/**
	 * When true, the row renders muted (opacity-50) and is non-interactive — onPress
	 * is suppressed and the switch right-item (if any) is also disabled. Used by
	 * settings screens to gray out SDK-touching controls offline; the global offline
	 * banner is the explanation.
	 */
	disabled?: boolean
	rightItem?:
		| {
				type: "switch"
				value: boolean
				onValueChange: (value: boolean) => void
		  }
		| {
				type: "text"
				value: string
		  }
		| {
				type: "badge"
				value: React.ReactNode | string
				color?: string
		  }
		| {
				type: "custom"
				value: React.ReactNode
		  }
}

function BadgePill({ value, color, textClassName }: { value: string | React.ReactNode; color?: string; textClassName?: string }) {
	return (
		<View
			className={cn("rounded-full size-5 flex-row items-center justify-center", !color && "bg-red-500")}
			style={color ? { backgroundColor: color } : undefined}
		>
			{typeof value === "string" ? (
				<Text
					className={textClassName}
					numberOfLines={1}
					ellipsizeMode="middle"
				>
					{value}
				</Text>
			) : (
				value
			)}
		</View>
	)
}

export function GroupButtonContainer(
	props: React.ComponentPropsWithoutRef<typeof PressableOpacity> &
		React.ComponentPropsWithoutRef<typeof View> & {
			children?: React.ReactNode
		}
) {
	if (props.onPress && props.enabled) {
		return <PressableOpacity {...props}>{props.children}</PressableOpacity>
	}

	return <View {...props}>{props.children}</View>
}

export function Group({ buttons, className }: { buttons: Button[]; className?: string }) {
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	return (
		<View className={cn("bg-background-secondary rounded-3xl overflow-hidden", className)}>
			{buttons.map(
				(
					{
						onPress,
						icon,
						iconSize,
						iconColor,
						leading,
						title,
						subTitle,
						subTitleNumberOfLines,
						rightItem,
						badge,
						badgeColor,
						titleClassName,
						subTitleClassName,
						disabled
					},
					index
				) => {
					return (
						<GroupButtonContainer
							key={index}
							className={cn("bg-transparent flex-row items-center gap-4 px-4", disabled && "opacity-50")}
							onPress={onPress}
							rippleColor={onPress && !disabled ? undefined : "transparent"}
							enabled={!!onPress && !disabled}
						>
							{leading ? (
								<View className="bg-transparent flex-row items-center">{leading}</View>
							) : (
								icon && (
									<View className="bg-transparent flex-row items-center">
										<Ionicons
											name={icon}
											size={iconSize ?? 22}
											color={iconColor ?? textForeground.color}
										/>
									</View>
								)
							)}
							<View
								className={cn(
									"bg-transparent flex-row items-center py-3 justify-between flex-1 gap-4",
									index !== buttons.length - 1 && "border-b border-separator"
								)}
							>
								{subTitle ? (
									<View className="flex-1 flex-col bg-transparent justify-center">
										<Text
											numberOfLines={1}
											ellipsizeMode="middle"
											className={titleClassName}
										>
											{title}
										</Text>
										<Text
											className={cn("text-muted-foreground text-xs", subTitleClassName)}
											numberOfLines={subTitleNumberOfLines}
											ellipsizeMode={subTitleNumberOfLines !== undefined ? "tail" : undefined}
										>
											{subTitle}
										</Text>
									</View>
								) : (
									<Text
										numberOfLines={1}
										ellipsizeMode="middle"
										className={cn("flex-1", titleClassName)}
									>
										{title}
									</Text>
								)}
								<View className="flex-row items-center gap-2 shrink-0 bg-transparent">
									{badge && (
										<BadgePill
											value={badge}
											color={badgeColor}
											textClassName="text-xs"
										/>
									)}
									{rightItem?.type === "text" && (
										<View className="items-center flex-row bg-transparent max-w-32">
											<Text
												className="text-sm text-muted-foreground"
												numberOfLines={1}
												ellipsizeMode="middle"
											>
												{rightItem.value}
											</Text>
										</View>
									)}
									{rightItem?.type === "badge" && (
										<BadgePill
											value={rightItem.value}
											color={rightItem.color}
											textClassName="text-white text-xs"
										/>
									)}
									{rightItem?.type === "switch" && (
										<View className="items-center flex-row bg-transparent">
											<Switch
												value={rightItem.value}
												onValueChange={rightItem.onValueChange}
												disabled={disabled}
											/>
										</View>
									)}
									{rightItem?.type === "custom" && (
										<View className="items-center flex-row bg-transparent">{rightItem.value}</View>
									)}
									{onPress && !disabled && (
										<Ionicons
											className="shrink-0"
											name="chevron-forward-outline"
											size={18}
											color={textMutedForeground.color}
										/>
									)}
								</View>
							</View>
						</GroupButtonContainer>
					)
				}
			)}
		</View>
	)
}
