import { useEffect, useState } from "react"
import { View } from "react-native"
import { useTranslation } from "react-i18next"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Animated, { FadeInDown, FadeOutUp } from "react-native-reanimated"
import Ionicons from "@expo/vector-icons/Ionicons"
import Text from "@/components/ui/text"
import useIsOnline from "@/hooks/useIsOnline"
import useIsAppActive from "@/hooks/useIsAppActive"
import useAppStore from "@/stores/useApp.store"
import { useIsAuthed } from "@/lib/auth"

type Status = "online" | "offline" | "back-online"

const Banner = ({ status }: { status: Exclude<Status, "online"> }) => {
	const { t } = useTranslation()
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
				<Text className="ml-2 text-sm leading-5 text-white">{isOffline ? t("youre_offline") : t("back_online")}</Text>
			</View>
		</Animated.View>
	)
}

const OfflineBanner = () => {
	const isOnline = useIsOnline()
	const isActive = useIsAppActive()
	const isAuthed = useIsAuthed()
	const biometricUnlocked = useAppStore(state => state.biometricUnlocked)
	const [status, setStatus] = useState<Status>(isOnline ? "online" : "offline")

	// isOnline drives status transitions into "offline" / "back-online". Done as a
	// during-render adjustment (the React-recommended pattern over a setState-in-
	// effect) so the new status commits in the same render pass with no intermediate
	// paint. The isOnline !== prevIsOnline guard makes it fire once per change.
	const [prevIsOnline, setPrevIsOnline] = useState(isOnline)

	if (isOnline !== prevIsOnline) {
		setPrevIsOnline(isOnline)

		if (!isOnline) {
			setStatus("offline")
		} else {
			setStatus(prev => (prev === "offline" ? "back-online" : prev))
		}
	}

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

	// Coordination with the existing root overlay applies ONLY when the user is
	// authed — <Biometric /> only mounts inside the authed Fragment. On auth
	// screens (login / register) the user has no biometric lock and the banner
	// should surface immediately so they understand why "sign in" / "register"
	// can't fire. (Privacy-screen redaction is now native/app-wide — not a React
	// overlay — so it no longer factors into this gate.)
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
}

export default OfflineBanner
