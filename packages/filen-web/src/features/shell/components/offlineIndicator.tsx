import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { WifiOffIcon, WifiIcon } from "lucide-react"
import { useIsOnline } from "@/lib/useIsOnline"
import { nextOfflineStatus, toIndicatorStatus } from "@/features/shell/lib/offlineIndicator.logic"
import { cn } from "@/lib/utils"

const BACK_ONLINE_DURATION_MS = 2000

// Mounted exactly once at the app root (RootLayout) — a fixed, non-blocking pill that overlays
// every route, so the same instance covers both the authed shell and the unauthenticated sign-in/
// register/reset pages without a second mount. Renders nothing while online; a calm neutral pill
// while offline; a brief success pill confirming "Back online" that then self-dismisses.
export function OfflineIndicator() {
	const { t } = useTranslation()
	const isOnline = useIsOnline()
	const [status, setStatus] = useState<"online" | "offline" | "back-online">(isOnline ? "online" : "offline")
	const [prevIsOnline, setPrevIsOnline] = useState(isOnline)

	// During-render adjustment (React-recommended over setState-in-effect) so the new status commits
	// in the same pass with no intermediate paint; the guard fires it once per actual flip.
	if (isOnline !== prevIsOnline) {
		setPrevIsOnline(isOnline)
		setStatus(prev => nextOfflineStatus(prev, isOnline))
	}

	// "back-online" is transient — decay to "online" (which renders nothing) after the confirmation
	// window. Cleanup cancels the timer if connectivity drops again before it elapses.
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

	const indicatorStatus = toIndicatorStatus(status)

	if (indicatorStatus === "hidden") {
		return null
	}

	const offline = indicatorStatus === "offline"

	return (
		<div
			role="status"
			aria-live="polite"
			className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center"
		>
			<div
				className={cn(
					"flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium shadow-sm",
					offline ? "text-muted-foreground" : "text-foreground"
				)}
			>
				{offline ? <WifiOffIcon className="size-3.5" /> : <WifiIcon className="size-3.5" />}
				{offline ? t("offline") : t("backOnline")}
			</div>
		</div>
	)
}
