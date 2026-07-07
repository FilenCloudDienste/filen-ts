import { useTranslation } from "react-i18next"
import type { ratePasswordStrength } from "@filen/utils"
import { cn } from "@/lib/utils"

export type PasswordStrengthTier = ReturnType<typeof ratePasswordStrength>["strength"]

const STRENGTH_STEP: Record<PasswordStrengthTier, number> = {
	weak: 1,
	normal: 2,
	strong: 3,
	best: 4
}

// This theme is grayscale-plus-destructive only (see index.css) — no green/amber tokens exist to
// borrow, so the fill stays within that palette: destructive flags the weak tier (consistent with
// how destructive already marks invalid state everywhere else in this app), the rest step through
// foreground opacity.
const STRENGTH_FILL_CLASS: Record<PasswordStrengthTier, string> = {
	weak: "bg-destructive",
	normal: "bg-muted-foreground",
	strong: "bg-foreground/70",
	best: "bg-foreground"
}

const STRENGTH_LABEL_KEY = {
	weak: "passwordStrengthWeak",
	normal: "passwordStrengthNormal",
	strong: "passwordStrengthStrong",
	best: "passwordStrengthBest"
} as const satisfies Record<PasswordStrengthTier, string>

// Live strength feedback shared by the register and reset forms. Width steps in quarters rather
// than a continuous scale, per a simple width-stepped bar. Both consuming forms gate their submit
// on isPasswordStrongEnough (weak is the only blocked tier), so the weak tier also renders the
// "choose a stronger password" helper here — the gate's explanation lives in one place and the
// two forms cannot diverge.
function StrengthMeter({ tier }: { tier: PasswordStrengthTier }) {
	const { t } = useTranslation("auth")

	return (
		<div className="flex flex-col gap-1">
			<div className="h-1 w-full overflow-hidden rounded-full bg-muted">
				<div
					className={cn("h-full rounded-full transition-all", STRENGTH_FILL_CLASS[tier])}
					style={{ width: `${String((STRENGTH_STEP[tier] / 4) * 100)}%` }}
				/>
			</div>
			<p className={cn("text-xs", tier === "weak" ? "text-destructive" : "text-muted-foreground")}>{t(STRENGTH_LABEL_KEY[tier])}</p>
			{tier === "weak" && <p className="text-xs text-destructive">{t("passwordStrengthTooWeak")}</p>}
		</div>
	)
}

export { StrengthMeter }
