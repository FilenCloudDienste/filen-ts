import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { PdfEditState } from "@filen/office/core/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { Button } from "@/components/ui/button"
import { chooseProtection, refusalKey, unlockOwnerRights } from "@/features/pdf/security/protectSession"
import { useOwnerUnlock } from "@/features/pdf/security/useOwnerUnlock"

// The Protect conditions said under the ribbon once the editor has the document: the author's restrictions that
// disable tools (with Unlock, the owner password prompt), and outdated RC4 encryption (with Upgrade to AES-256 on the
// next save, or Not now for this session).

const LINE = "flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"

export interface ProtectNoticesInput {
	readonly state: PdfEditState | null
	// Runs `change` on the editor session; `dropped` when it never will.
	readonly edit: (change: (session: PdfEditSessionModel) => Promise<unknown>, dropped: () => void) => void
	// The owner password unlocked the document.
	readonly onUnlocked: (password: string) => void
}

// Whether the author's restrictions stop some change now.
export function ownerRestricted(state: PdfEditState): boolean {
	const { restrictions } = state

	return (
		!restrictions.owner &&
		(!restrictions.edit || !restrictions.annotate || !restrictions.form || !restrictions.assemble || !restrictions.print)
	)
}

// The change's value, or null when it failed or never ran.
function onSession<T>(
	input: ProtectNoticesInput,
	change: (session: PdfEditSessionModel) => Promise<T>
): Promise<{ readonly value: T } | null> {
	return new Promise(resolve => {
		input.edit(
			session =>
				change(session).then(
					value => {
						resolve({ value })
					},
					() => {
						resolve(null)
					}
				),
			() => {
				resolve(null)
			}
		)
	})
}

export function useProtectNotices(input: ProtectNoticesInput): { readonly banner: ReactNode; readonly dialog: ReactNode } {
	const { t } = useTranslation("preview")
	const [dismissed, setDismissed] = useState(false)
	const unlock = useOwnerUnlock(async password => {
		const unlocked = await onSession(input, session => unlockOwnerRights(session, password))

		if (unlocked?.value === true) input.onUnlocked(password)

		return unlocked === null ? null : unlocked.value
	})
	const { state } = input

	if (state === null) return { banner: null, dialog: unlock.dialog }

	const security = state.security
	const restricted = ownerRestricted(state)
	const offerUpgrade = security.rc4 && security.upgrade === null && security.pending === null && !dismissed

	return {
		banner: (
			<>
				{restricted ? (
					<div
						role="status"
						className={LINE}
					>
						<p className="min-w-0 flex-1">{t("previewPdfOwnerRestricted")}</p>
						<Button
							variant="outline"
							size="xs"
							onClick={unlock.open}
						>
							{t("previewPdfSecurityUnlockAction")}
						</Button>
					</div>
				) : null}
				{offerUpgrade ? (
					<div
						role="status"
						className={LINE}
					>
						<p className="min-w-0 flex-1">{t("previewPdfSecurityUpgrade")}</p>
						<Button
							variant="outline"
							size="xs"
							onClick={() => {
								void onSession(input, session => chooseProtection(session, { kind: "upgrade" })).then(chosen => {
									if (chosen === null) toast.error(t("previewPdfSecurityFailed"))
									else if (chosen.value !== null) toast.error(t(refusalKey(chosen.value)))
								})
							}}
						>
							{t("previewPdfSecurityUpgradeAction")}
						</Button>
						<Button
							variant="ghost"
							size="xs"
							onClick={() => {
								setDismissed(true)
							}}
						>
							{t("previewPdfSecurityUpgradeDismiss")}
						</Button>
					</div>
				) : null}
				{security.pending === "upgrade" ? (
					<div
						role="status"
						className={LINE}
					>
						<p className="min-w-0 flex-1">{t("previewPdfSecurityUpgradePending")}</p>
					</div>
				) : null}
			</>
		),
		dialog: unlock.dialog
	}
}
