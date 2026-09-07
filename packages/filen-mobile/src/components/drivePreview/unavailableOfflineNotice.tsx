import { useTranslation } from "react-i18next"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"

// The gallery page for a file the device cannot serve right now: offline, and the item is in
// neither the offline store nor a cache. Shared by galleryItem (any type) and previewRawImage.
const UnavailableOfflineNotice = ({ style }: { style: { width: number; height: number } }) => {
	const { t } = useTranslation()

	return (
		<View
			className="bg-transparent"
			style={style}
		>
			<View className="bg-transparent flex-1 items-center justify-center px-8">
				<Ionicons
					name="cloud-offline-outline"
					size={48}
					color="#9ca3af"
				/>
				<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("unavailable_offline")}</Text>
			</View>
		</View>
	)
}

export default UnavailableOfflineNotice
