import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { useAccountQuery } from "@/queries/account"
import { isStorageOverLimit } from "@filen/shared"
import { selectActiveReminder, type ReminderKind } from "@/features/settings/components/security/exportMasterKeys.logic"
import { isDesktopBilling, openWebBilling } from "@/features/settings/lib/billingLinks"
import { useReminderStore } from "@/features/shell/store/useReminderStore"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
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
// and advances the sequence (keys → storage → done). The storage dialog doubles as the storage-full
// dialog every refused upload raises through openStorageFull, with what the refusal said; it waits
// behind the keys reminder rather than stacking on it. Open trash goes where deleting for good frees
// space; View plans opens the plans, and on the desktop app (which has no Plans page) web billing in
// the browser.
export function AccountReminders() {
	const { t } = useTranslation(["auth", "settings"])
	const navigate = useNavigate()
	const accountQuery = useAccountQuery()
	const keysDismissed = useReminderStore(state => state.keysDismissed)
	const storageDismissed = useReminderStore(state => state.storageDismissed)
	const dismissKeys = useReminderStore(state => state.dismissKeys)
	const dismissStorage = useReminderStore(state => state.dismissStorage)
	const storageFullRequested = useReminderStore(state => state.storageFullRequested)
	const storageFullDetail = useReminderStore(state => state.storageFullDetail)
	const closeStorageFull = useReminderStore(state => state.closeStorageFull)

	const data = accountQuery.data

	const active: ReminderKind | null = selectActiveReminder({
		accountStatus: accountQuery.status,
		didExportMasterKeys: data?.didExportMasterKeys ?? false,
		storageOverLimit: data ? isStorageOverLimit(data) : false,
		keysFired: keysDismissed,
		storageFired: storageDismissed
	})

	const storageOpen = active === "storage" || (storageFullRequested && active !== "exportKeys")

	function closeStorage(): void {
		dismissStorage()
		closeStorageFull()
	}

	function openTrash(): void {
		closeStorage()
		void navigate({ to: "/trash" })
	}

	function viewPlans(): void {
		closeStorage()

		if (isDesktopBilling()) {
			openWebBilling()

			return
		}

		void navigate({ to: "/settings/plans" })
	}

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
				open={storageOpen}
				onOpenChange={next => {
					if (!next) {
						closeStorage()
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("storageLimitReminderTitle")}</AlertDialogTitle>
						<AlertDialogDescription>
							{storageFullRequested && storageFullDetail !== null
								? `${t("storageLimitReminderBody")} ${storageFullDetail}`
								: t("storageLimitReminderBody")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("storageLimitReminderDismiss")}</AlertDialogCancel>
						<AlertDialogCancel onClick={openTrash}>{t("storageLimitReminderOpenTrash")}</AlertDialogCancel>
						<AlertDialogAction
							autoFocus
							onClick={viewPlans}
						>
							{t("storageLimitReminderViewPlans")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
