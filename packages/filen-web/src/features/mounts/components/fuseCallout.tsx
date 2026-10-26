import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useShallow } from "zustand/shallow"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import { mountsApi, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { runMountsAction } from "@/features/mounts/lib/mountsActions"
import { FUSE_GAP_KEY, FUSE_INSTALL_KEY } from "@/features/mounts/lib/mountsStatus.logic"

// What the drive lacks to mount, when it lacks something: an Install button where the app ships the installer
// (WinFsp on Windows), what to install on Linux (fuse3, or no FUSE device at all in a container), else the plain fact.
// macOS always mounts (macFUSE when installed, else the system's NFS client).
export function FuseCallout() {
	const { t } = useTranslation("mounts")
	const fuse = useMountsStore(useShallow(state => ({ status: state.overview?.fuse ?? null, gap: state.overview?.fuseGap ?? null })))
	const [installing, setInstalling] = useState(false)

	if (fuse.status === null || fuse.status.state === "ready") {
		return null
	}

	async function install(): Promise<void> {
		setInstalling(true)

		const done = await runMountsAction(() => mountsApi().installFuse())

		setInstalling(false)

		if (done === null) {
			return
		}

		const message = t(FUSE_INSTALL_KEY[done.value])

		switch (done.value) {
			case "installed":
				toast.success(message)
				break
			case "rebootRequired":
				toast.info(message)
				break
			case "canceled":
				break
			case "failed":
				toast.error(message)
				break
		}
	}

	if (fuse.status.installable) {
		return (
			<DesktopCallout
				tone="warning"
				action={
					<Button
						variant="outline"
						size="xs"
						disabled={installing}
						onClick={() => {
							void install()
						}}
					>
						{installing ? <Spinner data-icon="inline-start" /> : null}
						{t("fuseInstall")}
					</Button>
				}
			>
				{t("fuseMissingInstallable")}
			</DesktopCallout>
		)
	}

	return <DesktopCallout tone="warning">{t(fuse.gap === null ? "fuseMissing" : FUSE_GAP_KEY[fuse.gap])}</DesktopCallout>
}
