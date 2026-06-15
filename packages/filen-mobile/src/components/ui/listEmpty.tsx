import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"

// Standard empty-state cell rendered inside list emptyComponent slots.
// `flex-1` + center alignment puts the content at the true middle of the list area.
// For `FlashList.ListEmptyComponent` usage, the list must set
// `contentContainerStyle={{ flexGrow: 1 }}` so this view can stretch to fill.
const ListEmpty = ({
	icon,
	title,
	description,
	action
}: {
	icon: React.ComponentProps<typeof Ionicons>["name"]
	title: string
	description?: string
	action?: React.ReactNode
}) => {
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	return (
		<View className="flex-1 items-center justify-center bg-transparent gap-0.5 px-16">
			<Ionicons
				name={icon}
				size={64}
				color={textMutedForeground.color}
			/>
			<Text className="text-base text-foreground mt-1 text-center max-w-xs">{title}</Text>
			{description ? <Text className="text-xs text-muted-foreground text-center max-w-xs">{description}</Text> : null}
			{action ? <View className="mt-4 bg-transparent">{action}</View> : null}
		</View>
	)
}

export default ListEmpty
