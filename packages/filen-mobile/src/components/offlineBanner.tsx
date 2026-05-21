import { memo, useEffect, useState } from "react"
import { View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Animated, { FadeInDown, FadeOutUp } from "react-native-reanimated"
import Ionicons from "@expo/vector-icons/Ionicons"
import Text from "@/components/ui/text"
import useIsOnline from "@/hooks/useIsOnline"
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
			className={isOffline ? "bg-warning" : "bg-green-600"}
		>
			<View className="flex-row items-center justify-center bg-transparent">
				<Ionicons
					name={isOffline ? "cloud-offline-outline" : "cloud-done-outline"}
					size={16}
					color="white"
				/>
				<Text className="ml-2 text-sm leading-5 text-white">{isOffline ? "tbd_offline" : "tbd_back_online"}</Text>
			</View>
		</Animated.View>
	)
})

const OfflineBanner = memo(() => {
	const isOnline = useIsOnline()
	const isActive = useIsAppActive()
	const isAuthed = useIsAuthed()
	const biometricUnlocked = useAppStore(state => state.biometricUnlocked)
	const [status, setStatus] = useState<Status>(isOnline ? "online" : "offline")

	// Effect A: isOnline drives status transitions into "offline" / "back-online".
	// Depends only on isOnline so the cleanup-cancels-timeout trap that bit the
	// previous draft (single effect with both [isOnline, status]) can't happen.
	useEffect(() => {
		if (!isOnline) {
			setStatus("offline")

			return
		}

		setStatus(prev => (prev === "offline" ? "back-online" : prev))
	}, [isOnline])

	// Effect B: when status reaches "back-online", schedule the transition to "online".
	// Cleanup clears the timeout if isOnline flips back to false before 2s elapses.
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

	// In-flow banner (not FullWindowOverlay, not absolute). Sits above the
	// <Stack> in _layout.tsx so stack-screen headers + buttons render below
	// it instead of being occluded. Page-sheet modals leave a visible strip
	// at top where the banner stays in view; transparent-modal previews
	// (drivePreview) cover it — acceptable because the user is already past
	// the connectivity-aware list at that point.
	return <Banner status={status} />
})

export default OfflineBanner
