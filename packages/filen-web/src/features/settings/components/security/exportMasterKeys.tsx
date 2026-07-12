import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { downloadTextFile } from "@/features/settings/lib/downloadTextFile"
import { useIsOnline } from "@/lib/useIsOnline"
import { type AccountQuerySuccess } from "@/queries/account"
import { buildMasterKeysFilename } from "@/features/settings/components/security/exportMasterKeys.logic"
import { Card, CardAction, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"

interface ExportMasterKeysCardProps {
	accountQuery: AccountQuerySuccess
}

// Red-badged whenever the server reports `didExportMasterKeys === false`. Confirm → exportMasterKeys()
// → immediate browser download (Blob + object URL, revoked after — see lib/download.ts) named
// `${email}.masterKeys.${timestamp}.txt` → refetch (the server flips the flag on the call itself, so
// the badge clears once the refetch lands).
function ExportMasterKeysCard({ accountQuery }: ExportMasterKeysCardProps) {
	const { t } = useTranslation(["auth", "common"])
	const isOnline = useIsOnline()
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
					disabled={!isOnline}
					title={!isOnline ? t("common:offlineActionDisabled") : undefined}
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

export { ExportMasterKeysCard }
