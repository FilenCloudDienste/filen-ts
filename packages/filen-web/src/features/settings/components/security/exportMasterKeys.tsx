import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { downloadTextFile } from "@/features/settings/lib/downloadTextFile"
import { useIsOnline } from "@/lib/useIsOnline"
import { accountQueryUpdate, type AccountQuerySuccess } from "@/queries/account"
import { buildMasterKeysFilename } from "@/features/settings/components/security/exportMasterKeys.logic"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface ExportMasterKeysRowProps {
	accountQuery: AccountQuerySuccess
}

// Badged "Not backed up" whenever the server reports `didExportMasterKeys === false`. Confirm →
// exportMasterKeys() → immediate browser download (Blob + object URL, revoked after — see lib/download.ts) named
// `${email}.masterKeys.${timestamp}.txt` → patch `didExportMasterKeys` (the server flips the flag on
// the call itself, so no read-back is needed to clear the badge).
function ExportMasterKeysRow({ accountQuery }: ExportMasterKeysRowProps) {
	const { t } = useTranslation(["auth", "settings", "common"])
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
			accountQueryUpdate(prev => ({ ...prev, didExportMasterKeys: true }))
		} catch (e) {
			toast.error(errorLabel(e))
		} finally {
			setPending(false)
		}
	}

	return (
		<SettingsRow
			label={t("settings:settingsMasterKeysRowTitle")}
			description={t("exportMasterKeysDescription")}
		>
			{!didExportMasterKeys && <Badge variant="destructive">{t("exportMasterKeysNotBackedUp")}</Badge>}
			<Button
				type="button"
				variant={didExportMasterKeys ? "outline" : "default"}
				aria-label={t("exportMasterKeysAction")}
				disabled={!isOnline}
				title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				onClick={() => {
					setConfirmOpen(true)
				}}
			>
				{t("settings:settingsMasterKeysExportAction")}
			</Button>

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
		</SettingsRow>
	)
}

export { ExportMasterKeysRow }
