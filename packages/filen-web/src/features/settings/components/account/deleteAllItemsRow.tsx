import { useTranslation } from "react-i18next"
import { formatBytes } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { DELETE_ALL_ITEMS_PHRASE } from "@/features/settings/lib/dangerPhrases"
import type { AccountQuerySuccess } from "@/queries/account"
import { invalidateDriveListings } from "@/features/drive/queries/drive"
import { invalidatePhotosListing } from "@/features/photos/queries/photos"
import { TypedDeleteRow } from "@/features/settings/components/account/typedDeleteRow"

interface DeleteAllItemsRowProps {
	accountQuery: AccountQuerySuccess
}

// One severity level up from DeleteAllVersionsRow: this wipes every file and directory in the account,
// not just version history. deleteAllItems() is NEVER e2e-invoked — it would nuke every other module's
// e2e fixtures on the shared account — unit/render-only in this repo's own test suite, same as
// DeleteAccountRow.
function DeleteAllItemsRow({ accountQuery }: DeleteAllItemsRowProps) {
	const { t } = useTranslation("settings")
	const { storageUsed } = accountQuery.data

	return (
		<TypedDeleteRow
			title={t("settingsDeleteAllItemsTitle")}
			description={t("settingsDeleteAllItemsDescription", { size: formatBytes(Number(storageUsed)) })}
			submitLabel={t("settingsDeleteAllItemsSubmit")}
			confirmBody={t("settingsDeleteAllItemsConfirmBody", { phrase: DELETE_ALL_ITEMS_PHRASE })}
			phrase={DELETE_ALL_ITEMS_PHRASE}
			successMessage={t("settingsDeleteAllItemsSuccess")}
			run={async () => {
				await sdkApi.deleteAllItems()
				// Nothing patches the listings here, and a read My Drive listing never refetches on its own. The
				// photos walk trusts itself for a while too; a mounted one re-walks, finds its root gone and resets.
				invalidateDriveListings()
				invalidatePhotosListing(null)
			}}
			onDeleted={() => {
				void accountQuery.refetch()
			}}
		/>
	)
}

export { DeleteAllItemsRow }
