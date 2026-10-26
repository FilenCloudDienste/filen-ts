import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { DesktopServeProtocol } from "@filen/shared/desktop"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { mountsApi } from "@/features/mounts/lib/mountsStore"
import { runMountsAction } from "@/features/mounts/lib/mountsActions"
import { PROTOCOL_LABEL_KEY } from "@/features/mounts/lib/mountsRoles"

// A server without sign-in (nfs) starts only with the user's word that anyone on this device can use it; the
// acknowledgement goes with the enable.
export function UnauthenticatedDialog({ protocol, onClose }: { protocol: DesktopServeProtocol; onClose: () => void }) {
	const { t } = useTranslation(["mounts", "common"])
	const [pending, setPending] = useState(false)
	const name = t(PROTOCOL_LABEL_KEY[protocol])

	async function enable(): Promise<void> {
		setPending(true)

		const done = await runMountsAction(() => mountsApi().setServe(protocol, { enabled: true, acknowledgeUnauthenticated: true }))

		setPending(false)

		if (done !== null) {
			onClose()
		}
	}

	return (
		<ConfirmDialog
			open
			pending={pending}
			title={t("unauthenticatedTitle", { protocol: name })}
			body={t("unauthenticatedBody", { protocol: name })}
			confirmLabel={t("unauthenticatedConfirm")}
			cancelLabel={t("common:cancel")}
			destructive
			onOpenChange={next => {
				if (!next) {
					onClose()
				}
			}}
			onConfirm={() => {
				void enable()
			}}
		/>
	)
}
