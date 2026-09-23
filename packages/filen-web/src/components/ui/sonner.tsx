import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTranslation } from "react-i18next"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useTheme } from "@/providers/themeProvider"
import { useToastClearance } from "@/lib/toastClearance"
import { TOAST_EDGE_OFFSET_PX, TOAST_MOBILE_EDGE_OFFSET_PX, TOAST_WIDTH_PX, toastBottomOffset } from "@/lib/toastClearance.logic"

// Registry default reads the theme from `next-themes`; this app owns its theme provider, so the
// import is repointed and `next-themes` is not a dependency. `theme` is "dark" | "light" | "system",
// exactly Sonner's own theme union — no cast needed.
const Toaster = ({ ...props }: ToasterProps) => {
	const { theme } = useTheme()
	const { t } = useTranslation("common")
	// Flush with the bottom edge unless a registered surface (selection bar, audio player, composer) occupies the
	// toast corner — then lifted by exactly its measured clearance. Top/left stay sonner's defaults.
	const clearance = useToastClearance()

	return (
		<Sonner
			theme={theme}
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4" />,
				error: <OctagonXIcon className="size-4" />,
				// data-slot="spinner" is what exempts it from the global reduced-motion freeze (index.css) —
				// a frozen loading toast reads as a hung app, the exact case that exemption exists for.
				loading: (
					<Loader2Icon
						data-slot="spinner"
						className="size-4 animate-spin"
					/>
				)
			}}
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
					"--border-radius": "var(--radius)",
					"--width": `${String(TOAST_WIDTH_PX)}px`
				} as React.CSSProperties
			}
			offset={{
				right: TOAST_EDGE_OFFSET_PX,
				bottom: toastBottomOffset({
					clearance,
					edge: TOAST_EDGE_OFFSET_PX
				})
			}}
			mobileOffset={{
				bottom: toastBottomOffset({
					clearance,
					edge: TOAST_MOBILE_EDGE_OFFSET_PX
				})
			}}
			// Every toast gets a tabbable dismiss — a timed-only toast is unreachable by keyboard. The
			// label rides inside toastOptions (sonner declares it there, not on ToasterProps) and is not
			// caller-overridable: a caller-supplied toastOptions replaces this object wholesale.
			closeButton
			toastOptions={{
				classNames: {
					toast: "cn-toast"
				},
				closeButtonAriaLabel: t("toastDismiss")
			}}
			{...props}
		/>
	)
}

export { Toaster }
