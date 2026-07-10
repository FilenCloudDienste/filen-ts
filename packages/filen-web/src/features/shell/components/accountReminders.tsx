import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { useAccountQuery } from "@/queries/account"
import {
	selectActiveReminder,
	isStorageOverLimit,
	reminderFired,
	markReminderFired,
	storageReminderFired,
	markStorageReminderFired,
	type ReminderKind
} from "@/features/settings/components/security/exportMasterKeys.logic"
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
// setState-in-effect. Dismissal is an EVENT that flips React state, which the compiler tracks (a
// module-flag read would be memoized past a bare force-update and never re-close the modal), so the
// selector re-runs and advances the sequence (keys → storage → done). The React state seeds from the
// module fired-flags (once per page load — the web equivalent of a native "once per unlock", there is
// no lock concept here) so the nag stays dismissed across any remount within this boot; dismissal also
// marks the module flag to keep that persistence in sync. A reload re-arms. The storage reminder is
// dismiss-only: mobile's equivalent is an info alert with no upgrade deep-link, so there is no
// verified action URL to wire here.
export function AccountReminders() {
	const { t } = useTranslation("auth")
	const navigate = useNavigate()
	const accountQuery = useAccountQuery()
	const [keysDismissed, setKeysDismissed] = useState(reminderFired)
	const [storageDismissed, setStorageDismissed] = useState(storageReminderFired)

	function dismissKeys(): void {
		markReminderFired()
		setKeysDismissed(true)
	}

	function dismissStorage(): void {
		markStorageReminderFired()
		setStorageDismissed(true)
	}

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
