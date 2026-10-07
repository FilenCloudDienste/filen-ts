import { useLayoutEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Logo } from "@/features/shell/components/logo"
import { useSignOutOverlayShown } from "@/features/shell/lib/signOutOverlay"

// The boot splash's look (index.html) for the sign-out wipe, so the reload that ends it hands over to the
// splash without a visible change of screen. The thumbnail wipe, the long part, reports no progress, so
// the bar is indeterminate: it starts where the splash starts and eases toward 90% over a long transition,
// fast at first and slower the longer the wipe runs, with no timer driving it.
export function SignOutOverlay() {
	const shown = useSignOutOverlayShown()

	return shown ? <SignOutScreen /> : null
}

function SignOutScreen() {
	const { t } = useTranslation("auth")
	const [started, setStarted] = useState(false)

	// The first frame paints the start value, so the transition to the target has something to run from.
	useLayoutEffect(() => {
		const frame = requestAnimationFrame(() => {
			setStarted(true)
		})

		return () => {
			cancelAnimationFrame(frame)
		}
	}, [])

	return (
		<div
			role="progressbar"
			aria-label={t("signingOut")}
			className="fixed inset-0 z-2147483647 flex flex-col items-center justify-center gap-8 bg-canvas text-primary"
		>
			<Logo className="size-12" />
			<div className="h-0.75 w-32 overflow-hidden rounded-[3px] bg-muted-foreground/20">
				<div
					className="h-full origin-left bg-current transition-transform duration-[12s] ease-[cubic-bezier(0.1,0.6,0.3,1)] motion-reduce:transition-none"
					style={{ transform: `scaleX(${started ? "0.9" : "0.08"})` }}
				/>
			</div>
			<p className="text-sm text-muted-foreground">{t("signingOut")}</p>
		</div>
	)
}
