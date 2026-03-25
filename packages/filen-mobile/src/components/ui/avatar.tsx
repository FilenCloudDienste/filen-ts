import Image from "@/components/ui/image"
import { memo } from "react"
import View from "@/components/ui/view"
import { cn } from "@filen/utils"
import type { ViewStyle, StyleProp } from "react-native"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import { useRecyclingState } from "@shopify/flash-list"

const Avatar = memo(
	(props: {
		size?: number
		source?: string | null | undefined
		className?: string
		style?: StyleProp<ViewStyle>
		immediateFallback?: boolean
		group?: number
		lastActive?: number
	}) => {
		const [hasError, setHasError] = useRecyclingState<boolean>(false, [props])
		const textMutedForeground = useResolveClassNames("text-muted-foreground")
		const size = props.size ?? 32

		const isOnline = !props.lastActive ? false : props.lastActive > new Date().getTime() - 300000

		const onFailure = () => {
			setHasError(true)
		}

		const onCompletion = () => {
			setHasError(false)
		}

		return (
			<View className="bg-transparent flex-row items-center justify-center shrink-0">
				{props.lastActive && (
					<View
						className={cn("size-3 absolute rounded-full z-100 bottom-0 right-0", isOnline ? "bg-green-500" : "bg-gray-500")}
					/>
				)}
				<View
					className={cn(
						"flex-row overflow-hidden rounded-full bg-background-tertiary items-center justify-center shrink-0",
						props.className
					)}
					style={[
						props.style,
						{
							width: size,
							height: size
						}
					]}
				>
					{props.group ? (
						<Ionicons
							name="people"
							size={size * 0.7}
							color={textMutedForeground.color}
						/>
					) : props.immediateFallback || hasError || !props.source ? (
						<Ionicons
							name="person"
							size={size * 0.7}
							color={textMutedForeground.color}
						/>
					) : (
						<Image
							className="shrink-0 bg-transparent"
							source={{
								uri: props.source
							}}
							onFailure={onFailure}
							onCompletion={onCompletion}
							style={{
								width: size,
								height: size
							}}
							resizeMode="cover"
							cachePolicy="dataCache"
						/>
					)}
				</View>
			</View>
		)
	}
)

export default Avatar
