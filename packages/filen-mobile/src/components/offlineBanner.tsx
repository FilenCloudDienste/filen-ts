import { memo, useEffect, useState } from "react"
import { View, Platform } from "react-native"
import { FullWindowOverlay } from "react-native-screens"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Animated, { FadeInDown, FadeOutUp } from "react-native-reanimated"
import Ionicons from "@expo/vector-icons/Ionicons"
import Text from "@/components/ui/text"
import useNetInfo from "@/hooks/useNetInfo"
import useIsAppActive from "@/hooks/useIsAppActive"
import useAppStore from "@/stores/useApp.store"
import { useIsAuthed } from "@/lib/auth"

type Status = "online" | "offline" | "back-online"

const Banner = memo(({ status }: { status: Exclude<Status, "online"> }) => {
	const insets = useSafeAreaInsets()
	const isOffline = status === "offline"

	return (
		<Animated.View
			entering={FadeInDown.duration(200)}
			exiting={FadeOutUp.duration(200)}
			style={{ paddingTop: insets.top + 8, paddingBottom: 8 }}
			className={`absolute left-0 right-0 top-0 z-50 ${isOffline ? "bg-warning" : "bg-green-600"}`}
		>
			<View className="flex-row items-center justify-center bg-transparent">
				<Ionicons
					name={isOffline ? "cloud-offline-outline" : "cloud-done-outline"}
					size={16}
					color="white"
				/>
				<Text className="ml-2 text-sm leading-5 text-white">
					{isOffline ? "tbd_offline" : "tbd_back_online"}
				</Text>
			</View>
		</Animated.View>
	)
})

Banner.displayName = "OfflineBannerInner"

const OfflineBanner = memo(() => {
	const { hasInternet } = useNetInfo()
	const isActive = useIsAppActive()
	const isAuthed = useIsAuthed()
	const biometricUnlocked = useAppStore(state => state.biometricUnlocked)
	const [status, setStatus] = useState<Status>(hasInternet ? "online" : "offline")

	// Effect A: hasInternet drives status transitions into "offline" / "back-online".
	// Depends only on hasInternet so the cleanup-cancels-timeout trap that bit the
	// previous draft (single effect with both [hasInternet, status]) can't happen.
	useEffect(() => {
		if (!hasInternet) {
			setStatus("offline")

			return
		}

		setStatus(prev => (prev === "offline" ? "back-online" : prev))
	}, [hasInternet])

	// Effect B: when status reaches "back-online", schedule the transition to "online".
	// Cleanup clears the timeout if hasInternet flips back to false before 2s elapses.
	useEffect(() => {
		if (status !== "back-online") {
			return
		}

		const t = setTimeout(() => {
			setStatus("online")
		}, 2000)

		return () => {
			clearTimeout(t)
		}
	}, [status])

	if (status === "online") {
		return null
	}

	// Coordination with the existing root overlays applies ONLY when the user is
	// authed — <Biometric /> and <PrivacyCover /> only mount inside the authed
	// Fragment. On auth screens (login / register) the user has no biometric
	// lock and the banner should surface immediately so they understand why
	// "sign in" / "register" can't fire.
	if (isAuthed && biometricUnlocked !== true) {
		return null
	}

	if (!isActive) {
		return null
	}

	const content = <Banner status={status} />

	// On iOS we wrap in a FullWindowOverlay so the banner stays above page-sheet
	// modals — same trick that <NotifierWrapper useRNScreensOverlay={true}> uses
	// and that <Biometric /> uses. On Android the absolute-positioned View at
	// z-50 inside the root tree is sufficient (no FullWindowOverlay support).
	if (Platform.OS === "ios") {
		return <FullWindowOverlay>{content}</FullWindowOverlay>
	}

	return content
})

OfflineBanner.displayName = "OfflineBanner"

export default OfflineBanner
