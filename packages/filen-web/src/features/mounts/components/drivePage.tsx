import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useShallow } from "zustand/shallow"
import { ArrowUpIcon } from "lucide-react"
import { formatBytes, formatBytesPerSecond } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { LoadingState } from "@/components/loadingState"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { desktopPlatform } from "@/lib/desktop"
import { log } from "@/lib/log"
import { SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import { PreferenceToggleRow, SettingsSelectRow } from "@/features/settings/components/settingRows"
import { EntryRow } from "@/features/desktop/components/entryRow"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import { mountsApi, useMountsStats, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { callMounts, runMountsAction } from "@/features/mounts/lib/mountsActions"
import { MOUNT_POINT_PROBLEM_KEY } from "@/features/mounts/lib/mountsErrors.logic"
import { driveReadOnlyLocked } from "@/features/mounts/lib/mountsStatus.logic"
import { useDriveControls } from "@/features/mounts/hooks/useDriveControls"
import { HeroSection, MountsNoticeBanner, MountsPage, RoleErrorCallout } from "@/features/mounts/components/mountsPage"
import { DriveHero } from "@/features/mounts/components/driveHero"
import { FuseCallout } from "@/features/mounts/components/fuseCallout"
import { TuningDialog } from "@/features/mounts/components/tuningDialog"

const WINDOWS = desktopPlatform() === "win32"

// macOS/Linux: the directory the drive mounts on, picked in the shell's dialog (the page only ever holds its id).
function MountPointRow({ mountPoint, disabled }: { mountPoint: string | null; disabled: boolean }) {
	const { t } = useTranslation("mounts")
	const [choosing, setChoosing] = useState(false)

	async function choose(): Promise<void> {
		setChoosing(true)

		try {
			const choice = await mountsApi().chooseMountPoint()

			if (choice.status === "refused") {
				toast.error(t("mountPointRefused", { path: choice.path, reason: t(MOUNT_POINT_PROBLEM_KEY[choice.problem]) }))
			} else if (choice.status === "ok") {
				await runMountsAction(() => mountsApi().setDrive({ mountPointId: choice.id }))
			}
		} catch (error) {
			log.warn("mounts", "mount point could not be chosen", error)
			toast.error(t("errorUnknown"))
		} finally {
			setChoosing(false)
		}
	}

	return (
		<SettingsRow
			label={t("driveMountPoint")}
			description={mountPoint ?? t("driveMountPointDefault")}
		>
			<Button
				variant="outline"
				aria-label={t("driveMountPointChoose")}
				disabled={disabled || choosing}
				onClick={() => {
					void choose()
				}}
			>
				{choosing ? <Spinner data-icon="inline-start" /> : null}
				{t("driveMountPointChooseAction")}
			</Button>
		</SettingsRow>
	)
}

// Windows: the letter the drive shows under. The free letters are read once per visit; the current one is always kept.
function DriveLetterRow({ driveLetter, disabled }: { driveLetter: string | null; disabled: boolean }) {
	const { t } = useTranslation("mounts")
	const id = useId()
	const [free, setFree] = useState<string[] | null>(null)
	const [pending, setPending] = useState(false)

	useEffect(() => {
		let live = true

		void callMounts(() => mountsApi().driveLetters()).then(result => {
			if (live) {
				setFree(result.ok ? result.value : [])
			}
		})

		return () => {
			live = false
		}
	}, [])

	const letters = free === null ? null : [...new Set([...(driveLetter === null ? [] : [driveLetter]), ...free])].sort().reverse()

	return (
		<SettingsSelectRow
			id={id}
			label={t("driveLetter")}
			description={driveLetter === null ? t("driveLetterDefault") : t("driveLetterDescription")}
			options={(letters ?? []).map(letter => ({ value: letter, label: `${letter}:` }))}
			value={letters === null ? undefined : (driveLetter ?? "")}
			disabled={disabled || pending}
			onChange={letter => {
				if (letter === driveLetter) {
					return
				}

				setPending(true)
				void runMountsAction(() => mountsApi().setDrive({ driveLetter: letter })).finally(() => {
					setPending(false)
				})
			}}
		/>
	)
}

// The shared cache: what it holds, what still waits to upload, clearing it (refused while uploads wait) and tuning.
function CacheGroup() {
	const { t } = useTranslation(["mounts", "common"])
	const cache = useMountsStore(useShallow(state => state.overview?.cache ?? null))
	const tuning = useMountsStore(state => state.overview?.tuning ?? null)
	const [clearing, setClearing] = useState<"confirm" | "running" | null>(null)
	const [tuningOpen, setTuningOpen] = useState(false)

	if (cache === null || tuning === null) {
		return null
	}

	const pending = cache.pendingUploads > 0

	async function clear(): Promise<void> {
		setClearing("running")

		const done = await runMountsAction(() => mountsApi().clearCache())

		setClearing(null)

		if (done !== null) {
			toast.success(t("cacheCleared"))
		}
	}

	return (
		<SettingsGroup title={t("driveGroupCache")}>
			{pending ? (
				<SettingsRow
					label={t("cachePendingLabel")}
					description={t("cachePending", { count: cache.pendingUploads })}
				/>
			) : null}
			{cache.erroredFiles > 0 ? (
				<SettingsRow
					label={t("cacheErroredLabel")}
					description={t("cacheErrored", { count: cache.erroredFiles })}
					destructive
				/>
			) : null}
			<SettingsRow
				label={t("cacheClear")}
				description={pending ? t("cacheClearPending") : t("cacheClearDescription")}
			>
				<Button
					variant="outline"
					aria-label={t("cacheClear")}
					disabled={pending || clearing !== null}
					onClick={() => {
						setClearing("confirm")
					}}
				>
					{clearing === "running" ? <Spinner data-icon="inline-start" /> : null}
					{t("cacheClearAction")}
				</Button>
			</SettingsRow>
			<SettingsRow
				label={t("tuningRow")}
				description={t("tuningRowDescription")}
			>
				<Button
					variant="outline"
					aria-label={t("tuningRow")}
					onClick={() => {
						setTuningOpen(true)
					}}
				>
					{t("tuningOpen")}
				</Button>
			</SettingsRow>
			<ConfirmDialog
				open={clearing !== null}
				pending={clearing === "running"}
				title={t("cacheClearTitle")}
				body={t("cacheClearBody")}
				confirmLabel={t("cacheClearAction")}
				cancelLabel={t("common:cancel")}
				onOpenChange={next => {
					if (!next) {
						setClearing(null)
					}
				}}
				onConfirm={() => {
					void clear()
				}}
			/>
			{tuningOpen ? (
				<TuningDialog
					tuning={tuning}
					onClose={() => {
						setTuningOpen(false)
					}}
				/>
			) : null}
		</SettingsGroup>
	)
}

// What leaves the drive's cache right now. Followed only while the drive is mounted and this page is open.
function TransfersGroup({ mounted }: { mounted: boolean }) {
	const { t } = useTranslation("mounts")
	const stats = useMountsStats(mounted)

	if (stats === null || (stats.transfers.length === 0 && stats.uploadsQueued === 0 && stats.uploadsInProgress === 0)) {
		return null
	}

	return (
		<SettingsGroup
			title={t("transfersHeading")}
			description={t("transfersCounts", { uploading: stats.uploadsInProgress, queued: stats.uploadsQueued })}
		>
			{stats.transfers.map(transfer => (
				<EntryRow
					key={transfer.name}
					path={transfer.name}
					detail={t("transferProgress", {
						bytes: formatBytes(transfer.bytes),
						total: formatBytes(transfer.total),
						speed: formatBytesPerSecond(transfer.speed)
					})}
				>
					<ArrowUpIcon
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
				</EntryRow>
			))}
		</SettingsGroup>
	)
}

// The network drive: a hero with its switch, where it mounts with Open and its cache, then where and how it mounts,
// what it is uploading, and the cache's own settings.
export function DrivePage() {
	const { t } = useTranslation("mounts")
	const controls = useDriveControls()

	if (controls === null) {
		return <LoadingState size="lg" />
	}

	const { drive, available, busy, setDrive } = controls

	return (
		<MountsPage
			role="drive"
			title={t("mountsNetworkDrive")}
		>
			<HeroSection>
				<DriveHero
					controls={controls}
					overview={false}
				/>
				{available ? null : <DesktopCallout tone="error">{t("unavailable")}</DesktopCallout>}
				<FuseCallout />
				<MountsNoticeBanner scope="drive" />
				<RoleErrorCallout error={drive.error} />
			</HeroSection>
			<SettingsGroup title={t("driveGroupDrive")}>
				{WINDOWS ? (
					<DriveLetterRow
						driveLetter={drive.driveLetter}
						disabled={busy}
					/>
				) : (
					<MountPointRow
						mountPoint={drive.mountPoint}
						disabled={busy}
					/>
				)}
				<PreferenceToggleRow
					title={t("driveReadOnly")}
					description={driveReadOnlyLocked(drive.state) ? t("driveReadOnlyLocked") : t("driveReadOnlyDescription")}
					checked={drive.readOnly}
					disabled={busy || driveReadOnlyLocked(drive.state)}
					onCheckedChange={readOnly => {
						setDrive({ readOnly })
					}}
				/>
			</SettingsGroup>
			<TransfersGroup mounted={drive.state === "running"} />
			<CacheGroup />
		</MountsPage>
	)
}
