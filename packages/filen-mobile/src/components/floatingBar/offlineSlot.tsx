import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "@/hooks/useResolveClassNames"
import { cn } from "@filen/shared"
import Ionicons from "@expo/vector-icons/Ionicons"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import useIsOnline from "@/hooks/useIsOnline"
import useIsAppActive from "@/hooks/useIsAppActive"
import useAppStore from "@/stores/useApp.store"
import { useIsAuthed } from "@/lib/auth"
import useIsConnectionUnverified from "@/hooks/useIsConnectionUnverified"
import { nextOfflineStatus, resolveConnectionSlotStatus, type OfflineStatus } from "@/components/floatingBar/offlineSlotStatus"

const BACK_ONLINE_DURATION_MS = 2000

export type OfflineSlotStatus = "hidden" | "offline" | "back-online" | "unverified"

/**
 * Owns the offline state machine for both surfaces (this slot authed, <OfflineBanner /> unauthed):
 * the during-render connectivity transition + the 2s "back-online" decay, the certificate-failure state
 * ("unverified": online, but the connection to Filen couldn't be verified), plus the root-overlay gates.
 * Returns "hidden" when there is nothing to show — online, app backgrounded, or (authed and) the
 * biometric lock hasn't been cleared (so the chip never paints behind the lock overlay). The
 * FloatingBar uses the result both to decide whether to render at all and what the slot shows.
 */
export function useOfflineSlotStatus(): OfflineSlotStatus {
	const isOnline = useIsOnline()
	const connectionUnverified = useIsConnectionUnverified()
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

	const shown = resolveConnectionSlotStatus(status, connectionUnverified)

	if (shown === "online") {
		return "hidden"
	}

	// Gate on the root overlays: never surface behind the biometric lock, and not while the app is
	// backgrounded (the root-overlay-coordination invariant).
	if (isAuthed && biometricUnlocked !== true) {
		return "hidden"
	}

	if (!isActive) {
		return "hidden"
	}

	return shown
}

const SLOT_ICONS = {
	offline: "cloud-offline-outline",
	"back-online": "cloud-done-outline",
	unverified: "warning-outline"
} as const satisfies Record<Exclude<OfflineSlotStatus, "hidden">, keyof typeof Ionicons.glyphMap>

/**
 * The offline chip for the floating bar — same visual language as the audio/transfers slots
 * (compact row, text-xs, no progress bar). Calm foreground color while offline or unverified; a brief
 * green "Back online" confirmation on reconnect. Non-interactive: there is nowhere to navigate.
 */
const OfflineSlot = ({ status }: { status: Exclude<OfflineSlotStatus, "hidden"> }) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const textSuccess = useResolveClassNames("text-success")
	const isBackOnline = status === "back-online"

	return (
		<View className="flex-1 flex-row items-center min-h-11 px-3 py-2 gap-2 bg-transparent">
			<Ionicons
				name={SLOT_ICONS[status]}
				size={18}
				color={isBackOnline ? textSuccess.color : textForeground.color}
				style={{ flexShrink: 0 }}
			/>
			<Text
				className={cn("text-xs shrink", isBackOnline ? "text-success" : "")}
				numberOfLines={1}
				ellipsizeMode="tail"
			>
				{status === "offline" ? t("offline") : status === "unverified" ? t("connection_unverified") : t("back_online")}
			</Text>
		</View>
	)
}

export default OfflineSlot
