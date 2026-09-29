import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { DELETE_ALL_VERSIONS_PHRASE } from "@/features/settings/lib/dangerPhrases"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Button } from "@/components/ui/button"
import { TypedConfirmDialog } from "@/components/dialogs/typedConfirmDialog"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

interface DeleteAllVersionsRowProps {
	accountQuery: AccountQuerySuccess
}

// The exact same TypedConfirmDialog primitive drive's emptyTrashButton already uses for an
// equally severe whole-drive-scale destructive op (rather than DeleteAccountRow's plain double
// ConfirmDialog chain — that row's two-stage shape exists for its 2FA-code branch, which this
// single-stage op has no equivalent of). The dialog's exact-match gate is what makes "type a wrong
// phrase, the button stays disabled" true. deleteAllVersions() is NEVER e2e-invoked — it would irreversibly wipe the
// shared account's version history — this row is unit/render-only in this repo's own test suite.
function DeleteAllVersionsRow({ accountQuery }: DeleteAllVersionsRowProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const { versionedFiles, versionedStorage } = accountQuery.data
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(false)

	async function handleConfirm(): Promise<void> {
		setPending(true)
		try {
			await sdkApi.deleteAllVersions()
			setOpen(false)
			toast.success(t("settingsDeleteAllVersionsSuccess"))
			void accountQuery.refetch()
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		} finally {
			setPending(false)
		}
	}

	return (
		<SettingsRow
			label={t("settingsDeleteAllVersionsTitle")}
			description={t("settingsDeleteAllVersionsDescription", {
				count: Number(versionedFiles),
				size: formatBytes(Number(versionedStorage))
			})}
			destructive
		>
			<Button
				type="button"
				variant="destructive"
				disabled={!isOnline}
				title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				onClick={() => {
					setOpen(true)
				}}
			>
				{t("settingsDeleteAllVersionsSubmit")}
			</Button>

			<TypedConfirmDialog
				open={open}
				pending={pending}
				title={t("settingsDeleteAllVersionsTitle")}
				body={t("settingsDeleteAllVersionsConfirmBody", { phrase: DELETE_ALL_VERSIONS_PHRASE })}
				matchLabel={t("settingsTypedConfirmLabel")}
				matchValue={DELETE_ALL_VERSIONS_PHRASE}
				confirmLabel={t("settingsDeleteAllVersionsSubmit")}
				cancelLabel={t("common:cancel")}
				onOpenChange={next => {
					if (!next) {
						setOpen(false)
					}
				}}
				onConfirm={() => {
					void handleConfirm()
				}}
			/>
		</SettingsRow>
	)
}

export { DeleteAllVersionsRow }
