import { ActivityIndicator } from "react-native"
import { FadeOut } from "react-native-reanimated"
import { AnimatedView } from "@/components/ui/animated"
import { PreviewStatusMessage } from "@/components/drivePreview/previewStatus"
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
				<PreviewStatusMessage
					icon="warning-outline"
					text={t("preview_load_failed")}
				/>
			)}
		</AnimatedView>
	)
}

export default PreviewLoadingOverlay
