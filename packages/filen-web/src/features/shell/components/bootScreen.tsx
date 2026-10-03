import { useTranslation } from "react-i18next"
import { Logo } from "@/features/shell/components/logo"
import { LoadingState } from "@/components/loadingState"

// Full-screen indeterminate boot state, shown only when index.html's splash is gone before boot settles
// (@/lib/bootSplash). A calm, centered brand moment rather than a busy loader.
export function BootScreen() {
	const { t } = useTranslation()

	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-8 bg-canvas p-6 text-foreground">
			<div className="flex flex-col items-center gap-3">
				<Logo className="size-12 text-primary" />
				<span className="font-heading text-xl font-medium tracking-tight">{t("appName")}</span>
			</div>
			<LoadingState
				size="lg"
				className="flex-none"
			/>
		</div>
	)
}
