import { ActivityIndicator, type StyleProp, type ViewStyle } from "react-native"
import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"

type PreviewStatusIcon = "cloud-offline-outline" | "warning-outline" | "document-outline"

// View defaults to bg-background; gallery pages pass bg-transparent.
export const PreviewSpinner = ({ className, style }: { className?: string; style?: StyleProp<ViewStyle> }) => {
	return (
		<View
			className={cn("flex-1 items-center justify-center", className)}
			style={style}
		>
			<ActivityIndicator
				size="small"
				color="white"
			/>
		</View>
	)
}

// Icon and text only, for callers that own their container (overlays).
export const PreviewStatusMessage = ({ icon, text }: { icon: PreviewStatusIcon; text: string }) => {
	return (
		<>
			<Ionicons
				name={icon}
				size={48}
				color="#9ca3af"
			/>
			<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{text}</Text>
		</>
	)
}

export const PreviewMessage = ({
	icon,
	text,
	onRetry,
	className,
	style
}: {
	icon: PreviewStatusIcon
	text: string
	onRetry?: () => void
	className?: string
	style?: StyleProp<ViewStyle>
}) => {
	const { t } = useTranslation()

	return (
		<View
			className={cn("flex-1 items-center justify-center px-8", className)}
			style={style}
		>
			<PreviewStatusMessage
				icon={icon}
				text={text}
			/>
			{onRetry && (
				<PressableScale
					className="mt-4"
					onPress={onRetry}
					hitSlop={10}
				>
					<Text className="text-sm leading-5 text-primary">{t("retry")}</Text>
				</PressableScale>
			)}
		</View>
	)
}
