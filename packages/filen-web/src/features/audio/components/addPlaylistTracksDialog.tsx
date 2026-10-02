import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CheckIcon } from "lucide-react"
import { addTracksToPlaylistAction } from "@/features/audio/lib/playlists"
import { isAudioItem } from "@/features/audio/lib/handoff"
import { type DriveItem } from "@/features/drive/lib/item"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import type { Playlist } from "@filen/shared"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { cn, driveItemName } from "@filen/shared"
import { pendingGuardedOpenChange } from "@/components/dialogs/dismissal.logic"
import { ItemIcon, DirectoryGlyph } from "@/features/drive/components/itemIcon"
import { PICKER_ROW_CLASS, PickerBreadcrumb, PickerListShell } from "@/features/drive/components/directoryPicker"
import { useDirectoryPicker, useDirectoryPickerFilter } from "@/features/drive/hooks/useDirectoryPicker"
import { ListFilterInput } from "@/components/listFilterInput"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { LIST_DIALOG_CLASS } from "@/components/dialogs/listDialog"

export interface AddPlaylistTracksDialogProps {
	playlist: Playlist
	onClose: () => void
}

interface AddTrackRowProps {
	item: DriveItem
	alreadyAdded: boolean
	selected: boolean
	disabled: boolean
	alreadyAddedLabel: string
	onDescend: (uuid: string) => void
	onToggle: (item: DriveItem) => void
}

// Its own component so a selection toggle re-renders only the toggled row, not the whole unvirtualized list.
function AddTrackRow({ item, alreadyAdded, selected, disabled, alreadyAddedLabel, onDescend, onToggle }: AddTrackRowProps) {
	return (
		<li>
			<button
				type="button"
				disabled={disabled}
				onClick={() => {
					if (item.type === "directory") {
						onDescend(item.data.uuid)
						return
					}

					onToggle(item)
				}}
				aria-pressed={item.type === "file" ? selected : undefined}
				className={cn(PICKER_ROW_CLASS, selected && "bg-accent/70 text-accent-foreground")}
			>
				{item.type === "directory" ? (
					<DirectoryGlyph
						color={item.data.color}
						className="size-4 shrink-0"
					/>
				) : (
					<ItemIcon
						item={item}
						className="size-4 shrink-0"
					/>
				)}
				<span className="min-w-0 flex-1 truncate">{driveItemName(item)}</span>
				{alreadyAdded ? (
					<span className="shrink-0 text-xs text-muted-foreground">{alreadyAddedLabel}</span>
				) : selected ? (
					<CheckIcon className="size-4 shrink-0 text-primary" />
				) : null}
			</button>
		</li>
	)
}

// Drive audio-file picker for "Add tracks", built on directoryPicker.tsx like the move and chat-attach
// pickers. Unlike those two single-purpose pickers, selection here is MULTI and persists
// across navigation — a directory row descends, an audio-file row toggles into a Map keyed by uuid (not
// a Set: the actual DriveItem is needed at submit time, and a Set would lose it the moment the user
// navigates away from the directory it came from). A track already in the target playlist renders
// disabled with an inline hint instead of being hidden — addTracksToPlaylistAction's own dedup against
// the freshest copy would silently no-op it anyway, so this is purely a click-saving affordance.
export function AddPlaylistTracksDialog({ playlist, onClose }: AddPlaylistTracksDialogProps) {
	const { t } = useTranslation("audio")
	const { pathStack, listingQuery, items: rows, namesQuery, descend, goRoot, goTo } = useDirectoryPicker()
	const [filter, setFilter] = useDirectoryPickerFilter(pathStack)
	const [selected, setSelected] = useState<Map<string, DriveItem>>(new Map())
	const [pending, setPending] = useState(false)
	const browsable = rows.filter(item => item.type === "directory" || isAudioItem(item))
	const filtered = filterDriveItemsByLocalSearch(browsable, filter)
	const existingUuids = new Set(playlist.files.map(file => file.uuid))
	const alreadyAddedLabel = t("alreadyInPlaylist")

	function toggle(item: DriveItem): void {
		setSelected(prev => {
			const next = new Map(prev)

			if (next.has(item.data.uuid)) {
				next.delete(item.data.uuid)
			} else {
				next.set(item.data.uuid, item)
			}

			return next
		})
	}

	const handleOpenChange = pendingGuardedOpenChange(pending, next => {
		if (!next) {
			onClose()
		}
	})

	async function handleAdd(): Promise<void> {
		if (selected.size === 0) {
			return
		}

		setPending(true)

		// No finally: the React Compiler cannot lower one, and would skip this whole component.
		let added: number

		try {
			added = await addTracksToPlaylistAction(playlist, [...selected.values()])
		} catch (error) {
			setPending(false)
			toast.error(errorLabel(error))
			return
		}

		setPending(false)

		if (added > 0) {
			toast.success(t("tracksAddedToast", { count: added }))
		}

		onClose()
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent
				closeButtonDisabled={pending}
				className={LIST_DIALOG_CLASS}
			>
				<DialogHeader>
					<DialogTitle>{t("addTracksDialogTitle")}</DialogTitle>
				</DialogHeader>
				<PickerBreadcrumb
					pathStack={pathStack}
					names={namesQuery.data}
					onRoot={goRoot}
					onJump={goTo}
				/>
				{rows.length > 0 ? (
					<ListFilterInput
						value={filter}
						onChange={setFilter}
						placeholder={t("addTracksFilterPlaceholder")}
						ariaLabel={t("addTracksFilterPlaceholder")}
					/>
				) : null}
				<PickerListShell
					listingQuery={listingQuery}
					isEmpty={filtered.length === 0}
				>
					{filtered.map(item => {
						const alreadyAdded = item.type === "file" && existingUuids.has(item.data.uuid)

						return (
							<AddTrackRow
								key={item.data.uuid}
								item={item}
								alreadyAdded={alreadyAdded}
								selected={selected.has(item.data.uuid)}
								disabled={item.data.undecryptable || alreadyAdded}
								alreadyAddedLabel={alreadyAddedLabel}
								onDescend={descend}
								onToggle={toggle}
							/>
						)
					})}
				</PickerListShell>
				<DialogFooter>
					<Button
						disabled={pending || selected.size === 0}
						onClick={() => {
							void handleAdd()
						}}
					>
						{pending && <Spinner data-icon="inline-start" />}
						{t("addTracksSubmit", { count: selected.size })}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
