import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/utils"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { DELETE_ALL_ITEMS_PHRASE } from "@/features/settings/lib/dangerPhrases"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { TypedConfirmDialog } from "@/components/dialogs/typedConfirmDialog"

interface DeleteAllItemsCardProps {
	accountQuery: AccountQuerySuccess
}

// Same TypedConfirmDialog pattern as DeleteAllVersionsCard, one severity level up: this wipes every
// file and directory in the account, not just version history. deleteAllItems() is NEVER e2e-invoked —
// it would nuke every other module's e2e fixtures on the shared account — unit/
// render-only in this repo's own test suite, same as DeleteAccountCard.
function DeleteAllItemsCard({ accountQuery }: DeleteAllItemsCardProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const { storageUsed } = accountQuery.data
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(false)

	async function handleConfirm(): Promise<void> {
		setPending(true)
		try {
			await sdkApi.deleteAllItems()
			setOpen(false)
			toast.success(t("settingsDeleteAllItemsSuccess"))
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
				<CardTitle>{t("settingsDeleteAllItemsTitle")}</CardTitle>
				<CardDescription>{t("settingsDeleteAllItemsDescription", { size: formatBytes(Number(storageUsed)) })}</CardDescription>
			</CardHeader>
			<CardFooter>
				<Button
					type="button"
					variant="destructive"
					disabled={!isOnline}
					onClick={() => {
						setOpen(true)
					}}
				>
					{t("settingsDeleteAllItemsSubmit")}
				</Button>
			</CardFooter>

			<TypedConfirmDialog
				open={open}
				pending={pending}
				title={t("settingsDeleteAllItemsTitle")}
				body={t("settingsDeleteAllItemsConfirmBody", { phrase: DELETE_ALL_ITEMS_PHRASE })}
				matchLabel={t("settingsTypedConfirmLabel")}
				matchValue={DELETE_ALL_ITEMS_PHRASE}
				confirmLabel={t("settingsDeleteAllItemsSubmit")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={next => {
					if (!next) {
						setOpen(false)
					}
				}}
				onConfirm={() => {
					void handleConfirm()
				}}
			/>
		</Card>
	)
}

export { DeleteAllItemsCard }
