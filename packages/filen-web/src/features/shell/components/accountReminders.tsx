import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { useAccountQuery } from "@/queries/account"
import { selectActiveReminder, isStorageOverLimit, type ReminderKind } from "@/features/settings/components/security/exportMasterKeys.logic"
import { useReminderStore } from "@/features/shell/store/useReminderStore"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle
} from "@/components/ui/alert-dialog"

// Blocking startup reminders for the authed shell, mounted once from AppShell (they concern any
// authed surface, not one route). Two account nags surface as modal dialogs on every boot until
// actioned: exporting master keys and being over the storage limit. The active reminder is DERIVED
// each render by the pure one-at-a-time selector (keys before storage) — no arming effect, so no
// setState-in-effect. Dismissal flips the page-load-scoped reminder store, so the selector re-runs
// and advances the sequence (keys → storage → done). The storage reminder is dismiss-only: mobile's
// equivalent is an info alert with no upgrade deep-link, so there is no verified action URL to wire here.
export function AccountReminders() {
	const { t } = useTranslation("auth")
	const navigate = useNavigate()
	const accountQuery = useAccountQuery()
	const keysDismissed = useReminderStore(state => state.keysDismissed)
	const storageDismissed = useReminderStore(state => state.storageDismissed)
	const dismissKeys = useReminderStore(state => state.dismissKeys)
	const dismissStorage = useReminderStore(state => state.dismissStorage)

	const data = accountQuery.data

	const active: ReminderKind | null = selectActiveReminder({
		accountStatus: accountQuery.status,
		didExportMasterKeys: data?.didExportMasterKeys ?? false,
		storageOverLimit: data ? isStorageOverLimit(data.storageUsed, data.maxStorage) : false,
		keysFired: keysDismissed,
		storageFired: storageDismissed
	})

	return (
		<>
			<ConfirmDialog
				open={active === "exportKeys"}
				pending={false}
				title={t("exportMasterKeysReminderTitle")}
				body={t("exportMasterKeysReminderBody")}
				confirmLabel={t("exportMasterKeysReminderAction")}
				cancelLabel={t("exportMasterKeysReminderDismiss")}
				onOpenChange={next => {
					if (!next) {
						dismissKeys()
					}
				}}
				onConfirm={() => {
					dismissKeys()
					void navigate({ to: "/settings/security" })
				}}
			/>

			<AlertDialog
				open={active === "storage"}
				onOpenChange={next => {
					if (!next) {
						dismissStorage()
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("storageLimitReminderTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("storageLimitReminderBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogAction
							autoFocus
							onClick={dismissStorage}
						>
							{t("storageLimitReminderDismiss")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
