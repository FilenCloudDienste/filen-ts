import { useEffect } from "react"
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import { queryClient } from "@/queries/client"
import { ThemeProvider } from "@/providers/themeProvider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { onAuthBroadcast } from "@/lib/sdk/session"
import { sdkApi } from "@/lib/sdk/client"
import { i18n } from "@/lib/i18n"
import { registerSW, applyUpdate } from "@/lib/sw/register"
import { useBootStore } from "@/stores/boot"
import { BootScreen } from "@/features/shell/components/bootScreen"
import { BootErrorScreen } from "@/features/shell/components/bootErrorScreen"

export const Route = createRootRoute({ component: RootLayout })

// Every route inherits this gate. It renders the boot/error screens in place of the route Outlet
// until the SDK is ready — except /no-coi and /no-opfs, which are intentionally boot-independent and
// always allowed through so a capability-gate failure can never loop back into a gate that will never
// reach "ready".
function BootGate() {
	const phase = useBootStore(s => s.phase)
	const reason = useBootStore(s => s.reason)
	const error = useBootStore(s => s.error)
	const pathname = useRouterState({ select: s => s.location.pathname })
	const navigate = useNavigate()
	const onNoCoi = pathname === "/no-coi"
	const onNoOpfs = pathname === "/no-opfs"

	// Cross-tab auth coordination. A BroadcastChannel never hears its own posts, so only OTHER tabs
	// react: a logout elsewhere reloads this tab (boot then lands on /login now that the shared kv
	// session is cleared); a login elsewhere reloads this tab only if it is still unauthed, so it
	// adopts the newly-persisted session. Each tab runs its own SDK worker, so a reload is the only way
	// to re-sync a tab's in-worker client with the shared session — no key material crosses the channel.
	useEffect(() => {
		return onAuthBroadcast(message => {
			if (message.kind === "logout") {
				location.reload()
				return
			}
			void sdkApi
				.hasClient()
				.catch(() => false)
				.then(authed => {
					if (!authed) {
						location.reload()
					}
				})
		})
	}, [])

	// A missing cross-origin-isolation, or unavailable OPFS storage, is a distinct, actionable
	// capability-gate failure with its own dedicated page (not the generic boot-error screen).
	useEffect(() => {
		if (reason === "coi" && !onNoCoi) {
			void navigate({ to: "/no-coi", replace: true })
			return
		}
		if (reason === "opfs" && !onNoOpfs) {
			void navigate({ to: "/no-opfs", replace: true })
		}
	}, [reason, onNoCoi, onNoOpfs, navigate])

	// Side effect off the boot state machine, not a phase of it: once the SDK is ready, register the
	// service worker and surface any waiting update as a dismissible reload prompt.
	useEffect(() => {
		if (phase !== "ready") {
			return
		}

		registerSW(() => {
			toast(i18n.t("updateReadyTitle"), {
				description: i18n.t("updateReadyBody"),
				duration: Infinity,
				action: { label: i18n.t("reload"), onClick: applyUpdate }
			})
		})
	}, [phase])

	if (onNoCoi || onNoOpfs) {
		return <Outlet />
	}
	if (phase === "ready") {
		return <Outlet />
	}
	if (phase === "error" && reason !== "coi" && reason !== "opfs") {
		return (
			<BootErrorScreen
				reason={reason}
				error={error}
			/>
		)
	}
	return <BootScreen />
}

function RootLayout() {
	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider>
				<TooltipProvider>
					<BootGate />
					{/* Bottom-right, lifted above the floating selection bar's band: the bar's trailing
					    buttons and the default toast viewport measurably overlap at ~1280px width, and a
					    transient toast then swallows clicks on a visibly-present button. Top positions are
					    no alternative — they intercepted the header buttons and the listing's first rows. */}
					<Toaster offset={{ bottom: 96 }} />
				</TooltipProvider>
			</ThemeProvider>
		</QueryClientProvider>
	)
}
