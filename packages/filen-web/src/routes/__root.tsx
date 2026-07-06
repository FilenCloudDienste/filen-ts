import { useEffect } from "react"
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import { queryClient } from "@/queries/client"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { bootSdk } from "@/lib/sdk/boot"
import { i18n } from "@/lib/i18n"
import { registerSW, applyUpdate } from "@/lib/sw/register"
import { useBootStore } from "@/stores/boot"
import { BootScreen } from "@/components/shell/boot-screen"
import { BootErrorScreen } from "@/components/shell/boot-error-screen"

export const Route = createRootRoute({ component: RootLayout })

// Boot runs exactly once per document load. A module-level guard (not component state) survives
// StrictMode's effect double-invoke and any remount of the gate, so `initThreadPool` is never re-run
// against the already-live worker.
let bootStarted = false

// Every route inherits this gate. It renders the boot/error screens in place of the route Outlet
// until the SDK is ready — except /no-coi, which is intentionally SDK-free and always allowed through
// so a COI failure can never loop back into a gate that will never reach "ready".
function BootGate() {
	const phase = useBootStore(s => s.phase)
	const reason = useBootStore(s => s.reason)
	const error = useBootStore(s => s.error)
	const pathname = useRouterState({ select: s => s.location.pathname })
	const navigate = useNavigate()
	const onNoCoi = pathname === "/no-coi"

	useEffect(() => {
		if (bootStarted) {
			return
		}
		bootStarted = true
		void bootSdk()
	}, [])

	// A missing cross-origin-isolation is a distinct, actionable failure with its own page.
	useEffect(() => {
		if (reason === "coi" && !onNoCoi) {
			void navigate({ to: "/no-coi", replace: true })
		}
	}, [reason, onNoCoi, navigate])

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

	if (onNoCoi) {
		return <Outlet />
	}
	if (phase === "ready") {
		return <Outlet />
	}
	if (phase === "error" && reason !== "coi") {
		return (
			<BootErrorScreen
				reason={reason}
				error={error}
				onRetry={() => {
					void bootSdk()
				}}
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
					<Toaster />
				</TooltipProvider>
			</ThemeProvider>
		</QueryClientProvider>
	)
}
