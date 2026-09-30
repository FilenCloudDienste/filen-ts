import { View } from "react-native"
import { useTranslation } from "react-i18next"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Animated, { FadeInDown, FadeOutUp } from "react-native-reanimated"
import Ionicons from "@expo/vector-icons/Ionicons"
import Text from "@/components/ui/text"
import { useIsAuthed } from "@/lib/auth"
import { useOfflineSlotStatus, type OfflineSlotStatus } from "@/components/floatingBar/offlineSlot"

const Banner = ({ status }: { status: Exclude<OfflineSlotStatus, "hidden"> }) => {
	const { t } = useTranslation()
	const insets = useSafeAreaInsets()
	const isOffline = status === "offline"

	return (
		<Animated.View
			entering={FadeInDown.duration(200)}
			exiting={FadeOutUp.duration(200)}
			style={{ paddingTop: insets.top + 8, paddingBottom: 8 }}
			className={isOffline ? "bg-warning" : "bg-success"}
		>
			<View className="flex-row items-center justify-center bg-transparent">
				<Ionicons
					name={isOffline ? "cloud-offline-outline" : "cloud-done-outline"}
					size={16}
					color="white"
				/>
				<Text className="ml-2 text-sm leading-5 text-white">{isOffline ? t("youre_offline") : t("back_online")}</Text>
			</View>
		</Animated.View>
	)
}

// Offline indicator for the UNAUTHED surface only (login / register / public link). The authed
// surface is owned by the floating-bar offline slot (components/floatingBar/offlineSlot), which is
// mounted behind the isAuthed gate and only on the tabs. Removing this banner outright (680677e1)
// left the auth screens with no offline signal at all — the isOnline-gated "sign in" button became
// a silent, dimmed no-op with nothing explaining why (public-beta reports of a dead sign-in
// button). Keep exactly one signal per surface: this banner unauthed, the floating bar authed.
const OfflineBanner = () => {
	const status = useOfflineSlotStatus()
	const isAuthed = useIsAuthed()

	if (isAuthed || status === "hidden") {
		return null
	}

	// In-flow banner (not FullWindowOverlay, not absolute). Sits above the
	// <Stack> in _layout.tsx so stack-screen headers + buttons render below
	// it instead of being occluded.
	return <Banner status={status} />
}

export default OfflineBanner
