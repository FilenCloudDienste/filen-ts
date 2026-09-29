import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { WifiOffIcon, WifiIcon } from "lucide-react"
import { useIsOnline } from "@/lib/useIsOnline"
import { cn } from "@filen/shared"

const BACK_ONLINE_DURATION_MS = 2000

// Mounted exactly once at the app root (RootLayout) — a fixed, non-blocking pill that overlays
// every route, so the same instance covers both the authed shell and the unauthenticated sign-in/
// register/reset pages without a second mount. Renders nothing while online; a calm neutral pill
// while offline; a brief success pill confirming "Back online" that then self-dismisses.
export function OfflineIndicator() {
	const { t } = useTranslation()
	const isOnline = useIsOnline()
	// Offline is exactly `!isOnline`; only the transient "back online" confirmation needs state.
	const [backOnline, setBackOnline] = useState(false)
	const [prevIsOnline, setPrevIsOnline] = useState(isOnline)

	// During-render adjustment (React-recommended over setState-in-effect) so the new status commits
	// in the same pass with no intermediate paint; the guard fires it once per actual flip. A drop
	// clears the confirmation so the decay below restarts on the next return.
	if (isOnline !== prevIsOnline) {
		setPrevIsOnline(isOnline)
		setBackOnline(isOnline)
	}

	// The confirmation decays (rendering nothing) after its window. Cleanup cancels the timer if
	// connectivity drops again before it elapses.
	useEffect(() => {
		if (!backOnline) {
			return
		}

		const timeout = setTimeout(() => {
			setBackOnline(false)
		}, BACK_ONLINE_DURATION_MS)

		return () => {
			clearTimeout(timeout)
		}
	}, [backOnline])

	if (isOnline && !backOnline) {
		return null
	}

	const offline = !isOnline

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
