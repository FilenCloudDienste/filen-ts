import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { DELETE_ALL_VERSIONS_PHRASE } from "@/features/settings/lib/dangerPhrases"
import type { AccountQuerySuccess } from "@/queries/account"
import { TypedDeleteRow } from "@/features/settings/components/account/typedDeleteRow"

interface DeleteAllVersionsRowProps {
	accountQuery: AccountQuerySuccess
}

// A typed confirm rather than DeleteAccountRow's plain double ConfirmDialog chain — that row's
// two-stage shape exists for its 2FA-code branch, which this single-stage op has no equivalent of.
// deleteAllVersions() is NEVER e2e-invoked — it would irreversibly wipe the shared account's version
// history — this row is unit/render-only in this repo's own test suite.
function DeleteAllVersionsRow({ accountQuery }: DeleteAllVersionsRowProps) {
	const { t } = useTranslation("settings")
	const { versionedFiles, versionedStorage } = accountQuery.data

	return (
		<TypedDeleteRow
			title={t("settingsDeleteAllVersionsTitle")}
			description={t("settingsDeleteAllVersionsDescription", {
				count: Number(versionedFiles),
				size: formatBytes(Number(versionedStorage))
			})}
			submitLabel={t("settingsDeleteAllVersionsSubmit")}
			confirmBody={t("settingsDeleteAllVersionsConfirmBody", { phrase: DELETE_ALL_VERSIONS_PHRASE })}
			phrase={DELETE_ALL_VERSIONS_PHRASE}
			successMessage={t("settingsDeleteAllVersionsSuccess")}
			run={() => sdkApi.deleteAllVersions()}
			onDeleted={() => {
				void accountQuery.refetch()
			}}
		/>
	)
}

export { DeleteAllVersionsRow }
