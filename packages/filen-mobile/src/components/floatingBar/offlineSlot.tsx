import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/utils"
import Ionicons from "@expo/vector-icons/Ionicons"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import useIsOnline from "@/hooks/useIsOnline"
import useIsAppActive from "@/hooks/useIsAppActive"
import useAppStore from "@/stores/useApp.store"
import { useIsAuthed } from "@/lib/auth"
import { nextOfflineStatus, type OfflineStatus } from "@/components/floatingBar/offlineSlotStatus"

const BACK_ONLINE_DURATION_MS = 2000

export type OfflineSlotStatus = "hidden" | "offline" | "back-online"

/**
 * Owns the offline-slot state machine (replacing the old top-of-screen <OfflineBanner />): the
 * during-render connectivity transition + the 2s "back-online" decay, plus the root-overlay gates.
 * Returns "hidden" when there is nothing to show — online, app backgrounded, or (authed and) the
 * biometric lock hasn't been cleared (so the chip never paints behind the lock overlay). The
 * FloatingBar uses the result both to decide whether to render at all and what the slot shows.
 */
export function useOfflineSlotStatus(): OfflineSlotStatus {
	const isOnline = useIsOnline()
	const isActive = useIsAppActive()
	const isAuthed = useIsAuthed()
	const biometricUnlocked = useAppStore(state => state.biometricUnlocked)
	const [status, setStatus] = useState<OfflineStatus>(isOnline ? "online" : "offline")
	const [prevIsOnline, setPrevIsOnline] = useState(isOnline)

	// During-render adjustment (React-recommended over setState-in-effect) so the new status
	// commits in the same pass with no intermediate paint; the guard fires it once per change.
	if (isOnline !== prevIsOnline) {
		setPrevIsOnline(isOnline)
		setStatus(prev => nextOfflineStatus(prev, isOnline))
	}

	// "back-online" is transient — decay to "online" after the confirmation window. Cleanup cancels
	// the timer if connectivity flips back to offline before it elapses.
	useEffect(() => {
		if (status !== "back-online") {
			return
		}

		const timeout = setTimeout(() => {
			setStatus("online")
		}, BACK_ONLINE_DURATION_MS)

		return () => {
			clearTimeout(timeout)
		}
	}, [status])

	if (status === "online") {
		return "hidden"
	}

	// Gate on the root overlays: never surface behind the biometric lock, and not while the app is
	// backgrounded (mirrors the old banner + the root-overlay-coordination invariant).
	if (isAuthed && biometricUnlocked !== true) {
		return "hidden"
	}

	if (!isActive) {
		return "hidden"
	}

	return status
}

/**
 * The offline chip for the floating bar — same visual language as the audio/transfers slots
 * (compact row, text-xs, no progress bar). Calm foreground color while offline; a brief green
 * "Back online" confirmation on reconnect. Non-interactive: there is nowhere to navigate.
 */
const OfflineSlot = ({ status }: { status: Exclude<OfflineSlotStatus, "hidden"> }) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const textSuccess = useResolveClassNames("text-success")
	const isOffline = status === "offline"

	return (
		<View className="flex-1 flex-row items-center min-h-11 px-3 py-2 gap-2 bg-transparent">
			<Ionicons
				name={isOffline ? "cloud-offline-outline" : "cloud-done-outline"}
				size={18}
				color={isOffline ? textForeground.color : textSuccess.color}
				style={{ flexShrink: 0 }}
			/>
			<Text
				className={cn("text-xs shrink", isOffline ? "" : "text-success")}
				numberOfLines={1}
				ellipsizeMode="tail"
			>
				{isOffline ? t("offline") : t("back_online")}
			</Text>
		</View>
	)
}

export default OfflineSlot
