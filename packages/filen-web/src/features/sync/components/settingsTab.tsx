import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import type { DesktopSyncBacklog, DesktopSyncMode } from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"
import { syncApi, useSyncStore } from "@/features/sync/lib/syncStore"
import { runSyncAction } from "@/features/sync/lib/syncActions"
import { MODE_DESCRIPTION_KEY, MODE_KEY, MODES, modeChangeNeedsBacklog } from "@/features/sync/lib/syncStatus.logic"
import { useRemoteDirectoryName } from "@/features/sync/hooks/useRemoteDirectoryName"
import { BacklogDialog } from "@/features/sync/components/backlogDialog"
import { RemovePairDialog } from "@/features/sync/components/removePairDialog"

// The name field over the name as the shell holds it; remounted (keyed by the name) when it changes elsewhere.
function NameRow({ pairId, name }: { pairId: string; name: string }) {
	const { t } = useTranslation("sync")
	const id = useId()
	const [draft, setDraft] = useState(name)
	const [saving, setSaving] = useState(false)
	const trimmed = draft.trim()
	const canSave = !saving && trimmed.length > 0 && trimmed !== name

	async function save(): Promise<void> {
		setSaving(true)
		await runSyncAction(() => syncApi().renamePair(pairId, trimmed))
		setSaving(false)
	}

	return (
		<SettingsRow
			label={t("settingsName")}
			htmlFor={id}
		>
			<form
				className="flex items-center gap-2"
				onSubmit={event => {
					event.preventDefault()

					if (canSave) {
						void save()
					}
				}}
			>
				<Input
					id={id}
					value={draft}
					maxLength={255}
					disabled={saving}
					className="w-56 leading-5"
					onChange={event => {
						setDraft(event.target.value)
					}}
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={!canSave}
				>
					{saving ? <Spinner data-icon="inline-start" /> : null}
					{t("settingsNameSave")}
				</Button>
			</form>
		</SettingsRow>
	)
}

// A row whose one button runs a sync call, spinning while it does.
function ActionRow({
	label,
	description,
	action,
	disabled,
	variant,
	run
}: {
	label: string
	description?: string
	action: string
	disabled?: boolean
	variant?: "outline" | "destructive"
	run: () => Promise<unknown>
}) {
	const [running, setRunning] = useState(false)

	return (
		<SettingsRow
			label={label}
			description={description}
		>
			<Button
				variant={variant ?? "outline"}
				aria-label={label}
				disabled={running || disabled === true}
				onClick={() => {
					setRunning(true)
					void run().finally(() => {
						setRunning(false)
					})
				}}
			>
				{running ? <Spinner data-icon="inline-start" /> : null}
				{action}
			</Button>
		</SettingsRow>
	)
}

// The pair's settings: its name and directories, mode (leaving a backup mode asks about the backlog), pause and
// sync now, the sync trash (reveal only: emptying it is the user's call, in their file manager), and removal.
export function SettingsTab({ pairId }: { pairId: string }) {
	const { t } = useTranslation("sync")
	const id = useId()
	const pair = useSyncStore(
		useShallow(state => {
			const found = state.overview?.pairs.find(candidate => candidate.id === pairId)

			return found === undefined
				? null
				: { name: found.name, mode: found.mode, paused: found.paused, localRoot: found.localRoot, remoteRoot: found.remoteRoot }
		})
	)
	const remoteName = useRemoteDirectoryName(pair?.remoteRoot ?? "")
	const [backlogFor, setBacklogFor] = useState<DesktopSyncMode | null>(null)
	const [modePending, setModePending] = useState(false)
	const [removing, setRemoving] = useState(false)

	if (pair === null) {
		return null
	}

	const currentMode = pair.mode

	async function setMode(mode: DesktopSyncMode, backlog: DesktopSyncBacklog | null): Promise<void> {
		setModePending(true)

		if ((await runSyncAction(() => syncApi().setMode(pairId, mode, backlog))) !== null) {
			setBacklogFor(null)
		}

		setModePending(false)
	}

	return (
		<div className="flex flex-col gap-8">
			<SettingsGroup title={t("settingsGroupPair")}>
				<NameRow
					key={pair.name}
					pairId={pairId}
					name={pair.name}
				/>
				<ActionRow
					label={t("settingsLocal")}
					description={pair.localRoot}
					action={t("settingsRevealAction")}
					run={() => runSyncAction(() => syncApi().reveal(pairId, "root"))}
				/>
				<SettingsRow
					label={t("settingsRemote")}
					description={remoteName ?? "…"}
				/>
				<ActionRow
					label={t("settingsQuarantine")}
					description={t("settingsQuarantineDescription")}
					action={t("settingsRevealAction")}
					run={() => runSyncAction(() => syncApi().reveal(pairId, "quarantine"))}
				/>
			</SettingsGroup>
			<SettingsGroup title={t("settingsGroupSyncing")}>
				<SettingsSelectRow
					id={`${id}-mode`}
					label={t("settingsMode")}
					description={t(MODE_DESCRIPTION_KEY[currentMode])}
					options={MODES.map(mode => ({ value: mode, label: t(MODE_KEY[mode]) }))}
					value={currentMode}
					disabled={modePending}
					onChange={mode => {
						if (mode === currentMode) {
							return
						}

						if (modeChangeNeedsBacklog(currentMode, mode)) {
							setBacklogFor(mode)
						} else {
							void setMode(mode, null)
						}
					}}
				/>
				<ActionRow
					label={t("settingsPause")}
					description={t("settingsPauseDescription")}
					action={pair.paused ? t("settingsResumeAction") : t("settingsPauseAction")}
					run={() => runSyncAction(() => (pair.paused ? syncApi().resumePair(pairId) : syncApi().pausePair(pairId)))}
				/>
				<ActionRow
					label={t("settingsSyncNow")}
					description={t("settingsSyncNowDescription")}
					action={t("settingsSyncNow")}
					disabled={pair.paused}
					run={() => runSyncAction(() => syncApi().syncNow(pairId))}
				/>
			</SettingsGroup>
			<SettingsGroup
				title={t("settingsGroupDanger")}
				variant="danger"
			>
				<SettingsRow
					label={t("settingsRemove")}
					description={t("settingsRemoveDescription")}
				>
					<Button
						variant="destructive"
						aria-label={t("settingsRemove")}
						onClick={() => {
							setRemoving(true)
						}}
					>
						{t("settingsRemoveAction")}
					</Button>
				</SettingsRow>
			</SettingsGroup>
			{backlogFor === null ? null : (
				<BacklogDialog
					pending={modePending}
					onConfirm={backlog => {
						void setMode(backlogFor, backlog)
					}}
					onClose={() => {
						setBacklogFor(null)
					}}
				/>
			)}
			{removing ? (
				<RemovePairDialog
					pairId={pairId}
					name={pair.name}
					onClose={() => {
						setRemoving(false)
					}}
				/>
			) : null}
		</div>
	)
}
