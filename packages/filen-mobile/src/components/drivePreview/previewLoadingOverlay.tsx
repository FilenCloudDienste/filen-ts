import { ActivityIndicator } from "react-native"
import { FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useTranslation } from "react-i18next"

const PreviewLoadingOverlay = ({ status }: { status: "loading" | "error" }) => {
	const { t } = useTranslation()

	return (
		<AnimatedView
			pointerEvents="none"
			className="absolute inset-0 items-center justify-center bg-transparent px-8"
			exiting={FadeOut.duration(300)}
		>
			{status === "loading" ? (
				<ActivityIndicator
					size="small"
					color="white"
				/>
			) : (
				<>
					<Ionicons
						name="warning-outline"
						size={48}
						color="#9ca3af"
					/>
					<Text className="mt-4 text-center text-sm leading-5 text-muted-foreground">{t("preview_load_failed")}</Text>
				</>
			)}
		</AnimatedView>
	)
}

export default PreviewLoadingOverlay
