import { type StyleProp, type ViewStyle } from "react-native"
import { useTranslation } from "react-i18next"
import { PreviewMessage } from "@/components/drivePreview/previewStatus"

// The gallery page for a preview whose bytes could not be fetched. This app wires no
// refetch-on-focus (no focusManager; TanStack's default listens to a visibilitychange RN never
// fires), so the way back is an explicit Retry. The caller decides the background (View defaults
// to bg-background, the gallery wants transparent).
const PreviewLoadFailedNotice = ({
	onRetry,
	style,
	className
}: {
	onRetry: () => void
	style?: StyleProp<ViewStyle>
	className?: string
}) => {
	const { t } = useTranslation()

	return (
		<PreviewMessage
			icon="warning-outline"
			text={t("preview_load_failed")}
			onRetry={onRetry}
			className={className}
			style={style}
		/>
	)
}

export default PreviewLoadFailedNotice
