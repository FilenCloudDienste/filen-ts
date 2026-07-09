import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useTheme } from "@/providers/themeProvider"

// Registry default reads the theme from `next-themes`; this app owns its theme provider, so the
// import is repointed and `next-themes` is not a dependency. `theme` is "dark" | "light" | "system",
// exactly Sonner's own theme union — no cast needed.
const Toaster = ({ ...props }: ToasterProps) => {
	const { theme } = useTheme()

	return (
		<Sonner
			theme={theme}
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4" />,
				error: <OctagonXIcon className="size-4" />,
				loading: <Loader2Icon className="size-4 animate-spin" />
			}}
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
					"--border-radius": "var(--radius)"
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					toast: "cn-toast"
				}
			}}
			{...props}
		/>
	)
}

export { Toaster }
