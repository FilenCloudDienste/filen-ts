import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"

// The caps-lock hint under a password field (useCapsLock drives `active`), shared by every
// account-password field in the app, settings included.
//
// Rendered unconditionally with only its TEXT toggled: a live region must already be in the a11y tree
// when its content changes, so an already-populated role=status inserted on demand is commonly missed by
// screen readers. While empty it is zero-height but still a flex item, so the enclosing Field's gap-3 is
// cancelled — otherwise every password field would permanently carry one extra line of space.
//
// yellow-500 sits at ~1.9:1 on the light theme's near-white card, so the light shade goes one step darker.
function CapsLockWarning({ active }: { active: boolean }) {
	const { t } = useTranslation("auth")

	return (
		<p
			role="status"
			className={cn("text-xs text-yellow-600 dark:text-yellow-500", !active && "-mt-3")}
		>
			{active ? t("capsLockOn") : ""}
		</p>
	)
}

export { CapsLockWarning }
