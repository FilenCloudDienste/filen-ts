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

// Four distinct hues, one per tier — destructive flags weak (consistent with how destructive
// already marks invalid state everywhere else in this app), the rest borrow the same default
// Tailwind palette entries already used for non-semantic accents elsewhere in this app (e.g.
// driveRow.tsx's amber-500 favorite star, logsCard.tsx's yellow-500 warn level).
const STRENGTH_FILL_CLASS: Record<PasswordStrengthTier, string> = {
	weak: "bg-destructive",
	normal: "bg-yellow-500",
	strong: "bg-blue-500",
	best: "bg-green-500"
}

const STRENGTH_TEXT_CLASS: Record<PasswordStrengthTier, string> = {
	weak: "text-destructive",
	normal: "text-yellow-500",
	strong: "text-blue-500",
	best: "text-green-500"
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
			<p className={cn("text-xs font-medium", STRENGTH_TEXT_CLASS[tier])}>{t(STRENGTH_LABEL_KEY[tier])}</p>
			{tier === "weak" && <p className="text-xs text-destructive">{t("passwordStrengthTooWeak")}</p>}
		</div>
	)
}

export { StrengthMeter }
