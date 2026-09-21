import { type StyleProp, type ViewStyle } from "react-native"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"

// The gallery page for a preview whose bytes could not be fetched. This app wires no
// refetch-on-focus (no focusManager; TanStack's default listens to a visibilitychange RN never
// fires), so the way back is an explicit Retry. Shared by previewText and previewRawImage; the
// caller decides the background (View defaults to bg-background, the gallery wants transparent).
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
		<View
			className={cn("flex-1 items-center justify-center px-8", className)}
			style={style}
		>
			<Ionicons
				name="warning-outline"
				size={48}
				color="#9ca3af"
			/>
			<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("preview_load_failed")}</Text>
			<PressableScale
				className="mt-4"
				onPress={onRetry}
				hitSlop={10}
			>
				<Text className="text-sm leading-5 text-primary">{t("retry")}</Text>
			</PressableScale>
		</View>
	)
}

export default PreviewLoadFailedNotice
