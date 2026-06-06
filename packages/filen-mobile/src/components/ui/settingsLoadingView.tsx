import View from "@/components/ui/view"
import { ActivityIndicator } from "react-native"
import { useResolveClassNames } from "uniwind"

export function SettingsLoadingView() {
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View className="flex-1 bg-transparent items-center justify-center">
			<ActivityIndicator
				size="large"
				color={textForeground.color as string}
			/>
		</View>
	)
}
