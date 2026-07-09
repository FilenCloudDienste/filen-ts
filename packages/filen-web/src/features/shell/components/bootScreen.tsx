import { useTranslation } from "react-i18next"
import { Logo } from "@/features/shell/components/logo"
import { Spinner } from "@/components/ui/spinner"

// Full-screen indeterminate boot state shown while the SDK worker downloads + initializes. No
// determinate progress yet — wasm download progress is a later refinement; this is deliberately a
// calm, centered brand moment rather than a busy loader.
export function BootScreen() {
	const { t } = useTranslation()

	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-8 bg-background p-6 text-foreground">
			<div className="flex flex-col items-center gap-3">
				<Logo className="size-12 text-primary" />
				<span className="font-heading text-xl font-medium tracking-tight">{t("appName")}</span>
			</div>
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Spinner />
				<span>{t("bootDownloading")}</span>
			</div>
		</div>
	)
}
