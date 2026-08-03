import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTranslation } from "react-i18next"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useTheme } from "@/providers/themeProvider"

// Registry default reads the theme from `next-themes`; this app owns its theme provider, so the
// import is repointed and `next-themes` is not a dependency. `theme` is "dark" | "light" | "system",
// exactly Sonner's own theme union — no cast needed.
const Toaster = ({ ...props }: ToasterProps) => {
	const { theme } = useTheme()
	const { t } = useTranslation("common")

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
					"--border-radius": "var(--radius)"
				} as React.CSSProperties
			}
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
