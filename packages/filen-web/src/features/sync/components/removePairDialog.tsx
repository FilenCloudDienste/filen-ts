import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { syncApi } from "@/features/sync/lib/syncStore"
import { runSyncAction } from "@/features/sync/lib/syncActions"

// Removing a pair stops syncing it; the files stay on both sides. Lands on the Sync index afterwards, since the
// pair's own page is gone.
export function RemovePairDialog({ pairId, name, onClose }: { pairId: string; name: string; onClose: () => void }) {
	const { t } = useTranslation(["sync", "common"])
	const navigate = useNavigate()
	const [pending, setPending] = useState(false)

	async function remove(): Promise<void> {
		setPending(true)

		const done = await runSyncAction(() => syncApi().removePair(pairId))

		setPending(false)

		if (done !== null) {
			onClose()
			void navigate({ to: "/sync" })
		}
	}

	return (
		<ConfirmDialog
			open
			pending={pending}
			title={t("removeTitle", { name })}
			body={t("removeBody")}
			confirmLabel={t("settingsRemoveAction")}
			cancelLabel={t("common:cancel")}
			destructive
			onOpenChange={next => {
				if (!next) {
					onClose()
				}
			}}
			onConfirm={() => {
				void remove()
			}}
		/>
	)
}
