/* eslint-disable react-refresh/only-export-components -- this file exports the card component AND
   the useExportKeysReminder hook it shares a domain with (mirrors theme-provider.tsx's own
   ThemeProvider + useTheme pairing) */
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { downloadTextFile } from "@/features/settings/lib/downloadTextFile"
import { useAccountQuery, type AccountQuerySuccess } from "@/queries/account"
import {
	buildMasterKeysFilename,
	shouldShowExportReminder,
	reminderFired,
	markReminderFired
} from "@/features/settings/components/security/exportMasterKeys.logic"
import { Card, CardAction, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ConfirmDialog } from "@/components/dialogs/confirm-dialog"

interface ExportMasterKeysCardProps {
	accountQuery: AccountQuerySuccess
}

// Red-badged whenever the server reports `didExportMasterKeys === false`. Confirm → exportMasterKeys()
// → immediate browser download (Blob + object URL, revoked after — see lib/download.ts) named
// `${email}.masterKeys.${timestamp}.txt` → refetch (the server flips the flag on the call itself, so
// the badge clears once the refetch lands).
function ExportMasterKeysCard({ accountQuery }: ExportMasterKeysCardProps) {
	const { t } = useTranslation(["auth", "common"])
	const { email, didExportMasterKeys } = accountQuery.data
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [pending, setPending] = useState(false)

	async function handleExport(): Promise<void> {
		setPending(true)
		try {
			const masterKeys = await sdkApi.exportMasterKeys()
			downloadTextFile(buildMasterKeysFilename(email, Date.now()), masterKeys)
			setConfirmOpen(false)
			void accountQuery.refetch()
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		} finally {
			setPending(false)
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("exportMasterKeysAction")}</CardTitle>
				<CardDescription>{t("exportMasterKeysDescription")}</CardDescription>
				{!didExportMasterKeys && (
					<CardAction>
						<Badge
							variant="destructive"
							aria-label={t("exportMasterKeysNotBackedUp")}
						>
							!
						</Badge>
					</CardAction>
				)}
			</CardHeader>
			<CardFooter>
				<Button
					type="button"
					variant={didExportMasterKeys ? "outline" : "default"}
					onClick={() => {
						setConfirmOpen(true)
					}}
				>
					{t("exportMasterKeysAction")}
				</Button>
			</CardFooter>

			<ConfirmDialog
				open={confirmOpen}
				pending={pending}
				title={t("exportMasterKeysAction")}
				body={t("exportMasterKeysBody")}
				confirmLabel={t("exportMasterKeysAction")}
				cancelLabel={t("common:cancel")}
				onOpenChange={setConfirmOpen}
				onConfirm={() => {
					void handleExport()
				}}
			/>
		</Card>
	)
}

// Once-per-boot export-keys nag: mounted once from the authed shell (icon-rail.tsx), independent of
// whether the security page itself is open. Module-level `reminderFired`/`markReminderFired` (see
// export-master-keys.logic.ts) stand in for a native app's "once per unlock" gate — the web app has
// no lock/unlock concept, so "once per app boot" (i.e. once per module instance / page load) is the
// web-appropriate equivalent.
function useExportKeysReminder(): void {
	const { t } = useTranslation("auth")
	const navigate = useNavigate()
	const accountQuery = useAccountQuery()

	useEffect(() => {
		if (
			!shouldShowExportReminder({
				accountStatus: accountQuery.status,
				didExportMasterKeys: accountQuery.data?.didExportMasterKeys ?? false,
				alreadyFired: reminderFired()
			})
		) {
			return
		}

		markReminderFired()

		toast(t("exportMasterKeysReminderTitle"), {
			description: t("exportMasterKeysReminderBody"),
			duration: Infinity,
			action: {
				label: t("exportMasterKeysReminderAction"),
				onClick: () => {
					void navigate({ to: "/settings/security" })
				}
			},
			cancel: {
				label: t("exportMasterKeysReminderDismiss"),
				onClick: () => undefined
			}
		})
	}, [accountQuery.status, accountQuery.data?.didExportMasterKeys, navigate, t])
}

export { ExportMasterKeysCard, useExportKeysReminder }
