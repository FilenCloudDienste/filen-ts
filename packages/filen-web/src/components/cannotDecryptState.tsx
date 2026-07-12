import { useTranslation } from "react-i18next"
import { LockIcon } from "lucide-react"
import { cn } from "@/lib/utils"

// Shared explainer for an item whose metadata never decrypted (no usable key for this account) —
// rendered in place of the normal content on every surface an undecryptable item can still reach:
// the note editor pane (an undecryptable note has no body to edit) and the drive info dialog (its
// metadata rows would all fall back to the uuid). Mirrors mobile's CannotDecryptScreen — a short
// heading plus the one-line reason, centered. Purely presentational; the caller owns placement and
// sizing via `className`.
export function CannotDecryptState({ className }: { className?: string }) {
	const { t } = useTranslation("common")

	return (
		<div className={cn("flex flex-col items-center justify-center gap-3 p-8 text-center", className)}>
			<div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted">
				<LockIcon className="size-6 text-muted-foreground" />
			</div>
			<div className="flex flex-col gap-1">
				<p className="text-sm font-medium">{t("cannotDecryptTitle")}</p>
				<p className="max-w-xs text-sm text-muted-foreground">{t("cannotDecryptBody")}</p>
			</div>
		</div>
	)
}
