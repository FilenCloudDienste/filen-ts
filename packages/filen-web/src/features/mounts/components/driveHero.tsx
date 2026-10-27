import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { ExternalLinkIcon } from "lucide-react"
import { formatBytes } from "@filen/shared"
import { Switch } from "@/components/ui/switch"
import { desktopPlatform } from "@/lib/desktop"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { ActionRow } from "@/features/desktop/components/actionRow"
import { mountsApi, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { runMountsAction } from "@/features/mounts/lib/mountsActions"
import { FUSE_PROVIDER_KEY, roleStateKey } from "@/features/mounts/lib/mountsStatus.logic"
import type { DriveControls } from "@/features/mounts/hooks/useDriveControls"
import { RoleHero } from "@/features/mounts/components/roleHero"
import { RoleStatusDot } from "@/features/mounts/components/roleStatus"

const WINDOWS = desktopPlatform() === "win32"

// The drive's on/off switch, wherever it shows: always useDriveControls' path.
export function DriveSwitch({ controls }: { controls: DriveControls }) {
	const { t } = useTranslation("mounts")
	const { drive, busy, cannotMount, setDrive } = controls

	return (
		<Switch
			checked={drive.enabled}
			disabled={busy || (cannotMount && !drive.enabled)}
			aria-label={t("driveEnable")}
			onCheckedChange={enabled => {
				setDrive({ enabled })
			}}
		/>
	)
}

// The network drive at a glance: its state and switch, where it mounts with Open, and what its cache holds. In the
// overview its title links to the drive's page.
export function DriveHero({ controls, overview }: { controls: DriveControls; overview: boolean }) {
	const { t } = useTranslation("mounts")
	const { drive, fuse } = controls
	const cache = useMountsStore(state => state.overview?.cache ?? null)
	const stateLabel = t(roleStateKey("drive", drive.state))
	// What mounts it, once mounted.
	const provider = fuse?.state === "ready" && drive.state === "running" ? t(FUSE_PROVIDER_KEY[fuse.provider]) : null
	const where = WINDOWS
		? drive.driveLetter === null
			? t("driveLetterDefault")
			: `${drive.driveLetter}:`
		: (drive.mountPoint ?? t("driveMountPointDefault"))

	return (
		<RoleHero
			role="drive"
			state={drive.state}
			title={
				overview ? (
					<Link
						to="/mounts/$role"
						params={{ role: "drive" }}
						className="rounded-md focus-ring outline-none hover:underline hover:underline-offset-4"
					>
						{t("mountsNetworkDrive")}
					</Link>
				) : (
					stateLabel
				)
			}
			status={
				overview ? (
					<>
						<RoleStatusDot state={drive.state} />
						<span className="truncate">{provider === null ? stateLabel : t("driveOpenDescription", { provider })}</span>
					</>
				) : (
					<span className="truncate">
						{provider === null ? t("driveEnableDescription") : t("driveOpenDescription", { provider })}
					</span>
				)
			}
			control={<DriveSwitch controls={controls} />}
		>
			<ActionRow
				label={t("driveOpen")}
				description={where}
				action={t("driveOpenAction")}
				disabled={drive.state !== "running"}
				icon={<ExternalLinkIcon data-icon="inline-start" />}
				run={() => runMountsAction(() => mountsApi().revealDrive())}
			/>
			{cache === null ? null : (
				<SettingsRow
					label={t("driveGroupCache")}
					description={t("cacheUsageDescription", { used: formatBytes(cache.usedBytes), free: formatBytes(cache.freeBytes) })}
				/>
			)}
		</RoleHero>
	)
}
