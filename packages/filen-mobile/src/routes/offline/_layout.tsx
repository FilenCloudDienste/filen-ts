import { Stack } from "expo-router"
import { memo, Fragment } from "react"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useOfflineStore from "@/stores/useOffline.store"
import { useShallow } from "zustand/shallow"
import { Platform, ActivityIndicator } from "react-native"
import Text from "@/components/ui/text"
import { useResolveClassNames } from "uniwind"
import { useTranslation } from "react-i18next"

const Indicator = memo(() => {
	const insets = useSafeAreaInsets()
	const syncing = useOfflineStore(useShallow(state => state.syncing))
	const textForeground = useResolveClassNames("text-foreground")
	const { t } = useTranslation()

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
						{t("syncing")}
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
		<Fragment>
			<Stack />
			<Indicator />
		</Fragment>
	)
})

export default Layout
