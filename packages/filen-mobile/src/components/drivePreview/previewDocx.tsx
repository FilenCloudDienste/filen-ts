import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import DocxPreview from "@/components/docxPreview"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useFileBase64Query from "@/queries/useFileBase64.query"
import { ActivityIndicator } from "react-native"
import { useTranslation } from "react-i18next"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import type { GalleryItemTagged } from "@/components/drivePreview/gallery"

const PreviewDocx = ({ item }: { item: GalleryItemTagged }) => {
	const { t } = useTranslation()
	const headerHeight = useDrivePreviewStore(useShallow(state => state.headerHeight))
	const insets = useSafeAreaInsets()

	const query = useFileBase64Query(
		item.type === "external"
			? {
					type: "external",
					data: {
						url: item.data.url,
						name: item.data.name
					}
				}
			: {
					type: "drive",
					data: {
						uuid: item.data.data.uuid
					}
				}
	)

	if (query.status === "pending" && query.fetchStatus === "fetching") {
		return (
			<View className="bg-background flex-1 items-center justify-center">
				<ActivityIndicator
					size="small"
					color="white"
				/>
			</View>
		)
	}

	if (query.fetchStatus === "paused") {
		return (
			<View className="bg-background flex-1 items-center justify-center px-8">
				<Ionicons
					name="cloud-offline-outline"
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("unavailable_offline")}</Text>
			</View>
		)
	}

	if (query.status === "error") {
		return (
			<View className="bg-background flex-1 items-center justify-center px-8">
				<Ionicons
					name="warning-outline"
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("preview_load_failed")}</Text>
				<PressableScale
					className="mt-4"
					onPress={() => query.refetch()}
					hitSlop={10}
				>
					<Text className="text-sm leading-5 text-primary">{t("retry")}</Text>
				</PressableScale>
			</View>
		)
	}

	if (query.status === "success") {
		return (
			<View className="bg-background flex-1">
				<DocxPreview
					base64={query.data}
					paddingTop={headerHeight ? headerHeight : undefined}
					paddingBottom={insets.bottom}
				/>
			</View>
		)
	}

	return (
		<View className="bg-background flex-1 items-center justify-center">
			<ActivityIndicator
				size="small"
				color="white"
			/>
		</View>
	)
}

export default PreviewDocx
