import { Stack } from "expo-router"
import { memo } from "@/lib/memo"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useOfflineStore from "@/stores/useOffline.store"
import { useShallow } from "zustand/shallow"
import { Platform, ActivityIndicator } from "react-native"
import Text from "@/components/ui/text"
import { useResolveClassNames } from "uniwind"

const Indicator = memo(() => {
	const insets = useSafeAreaInsets()
	const syncing = useOfflineStore(useShallow(state => state.syncing))
	const textForeground = useResolveClassNames("text-foreground")

	if (!syncing) {
		return null
	}

	return (
		<View
			className="absolute left-0 right-0 bg-transparent px-4"
			style={{
				bottom: insets.bottom
			}}
		>
			<CrossGlassContainerView
				disableBlur={Platform.OS === "android"}
				className="flex-col overflow-hidden"
			>
				<View className="flex-row items-center justify-between bg-transparent px-4 py-3 gap-4 flex-1">
					<Text
						className="shrink-0 flex-1"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						tbd_syncing
					</Text>
					<ActivityIndicator
						className="shrink-0"
						size="small"
						color={textForeground.color}
					/>
				</View>
			</CrossGlassContainerView>
		</View>
	)
})

const Layout = memo(() => {
	return (
		<View className="flex-1">
			<Stack />
			<Indicator />
		</View>
	)
})

export default Layout
