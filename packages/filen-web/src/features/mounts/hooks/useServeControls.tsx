import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { DesktopServe, DesktopServePatch, DesktopServeProtocol } from "@filen/shared/desktop"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { mountsApi, useMountsServe, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { runMountsAction } from "@/features/mounts/lib/mountsActions"
import { enableNeedsAcknowledgement, httpsOffNeedsWarning, roleBusy } from "@/features/mounts/lib/mountsStatus.logic"
import { UnauthenticatedDialog } from "@/features/mounts/components/unauthenticatedDialog"

export interface ServeControls {
	serve: DesktopServe
	available: boolean
	// A call in flight, or the shell mid-transition: the server's controls wait.
	busy: boolean
	update: (patch: DesktopServePatch) => Promise<boolean>
	// Turning on a server without sign-in asks first.
	setEnabled: (enabled: boolean) => void
	// Turning https off where that sends credentials in plain text asks first.
	setHttps: (https: boolean) => void
	// The confirmations the two above open; render them once beside the controls.
	dialogs: ReactNode
}

// The one path every server switch takes, on its page and in the overview's tiles. null before the first overview.
export function useServeControls(protocol: DesktopServeProtocol): ServeControls | null {
	const { t } = useTranslation(["mounts", "common"])
	const serve = useMountsServe(protocol)
	const available = useMountsStore(state => state.overview?.available ?? true)
	const [pending, setPending] = useState(false)
	const [dialog, setDialog] = useState<"acknowledge" | "httpsOff" | null>(null)

	if (serve === null) {
		return null
	}

	async function update(patch: DesktopServePatch): Promise<boolean> {
		setPending(true)

		const done = await runMountsAction(() => mountsApi().setServe(protocol, patch))

		setPending(false)

		return done !== null
	}

	const current = serve

	return {
		serve,
		available,
		busy: pending || roleBusy(serve.state),
		update,
		setEnabled: enabled => {
			if (enabled && enableNeedsAcknowledgement(current)) {
				setDialog("acknowledge")
			} else {
				void update({ enabled })
			}
		},
		setHttps: https => {
			if (!https && httpsOffNeedsWarning(current)) {
				setDialog("httpsOff")
			} else {
				void update({ https })
			}
		},
		dialogs: (
			<>
				{dialog === "acknowledge" ? (
					<UnauthenticatedDialog
						protocol={protocol}
						onClose={() => {
							setDialog(null)
						}}
					/>
				) : null}
				<ConfirmDialog
					open={dialog === "httpsOff"}
					pending={pending}
					title={t("httpsOffTitle")}
					body={t("httpsOffBody", { address: serve.address })}
					confirmLabel={t("httpsOffConfirm")}
					cancelLabel={t("common:cancel")}
					destructive
					onOpenChange={next => {
						if (!next) {
							setDialog(null)
						}
					}}
					onConfirm={() => {
						void update({ https: false }).then(() => {
							setDialog(null)
						})
					}}
				/>
			</>
		)
	}
}
