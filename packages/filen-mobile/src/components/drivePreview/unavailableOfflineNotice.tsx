import { type StyleProp, type ViewStyle } from "react-native"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { PreviewMessage } from "@/components/drivePreview/previewStatus"

// The gallery page for a file the device cannot serve right now: offline, and the item is in
// neither the offline store nor a cache. Fills its parent. Transparent by default for galleryItem's
// window-sized cell; opaque previews pass their own background.
const UnavailableOfflineNotice = ({ className, style }: { className?: string; style?: StyleProp<ViewStyle> }) => {
	const { t } = useTranslation()

	return (
		<PreviewMessage
			icon="cloud-offline-outline"
			text={t("unavailable_offline")}
			className={cn("bg-transparent", className)}
			style={style}
		/>
	)
}

export default UnavailableOfflineNotice
