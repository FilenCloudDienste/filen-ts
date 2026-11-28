import { useTranslation } from "react-i18next"
import { InfoIcon, PanelRightIcon } from "lucide-react"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { type DriveDialogAction } from "@/features/drive/lib/selectionDispatch"
import { DETAILS_SETTLE_MS, selectionKey } from "@/features/drive/components/itemDetails.logic"
import { ItemDetails, SelectionDetails } from "@/features/drive/components/itemDetails"
import { DRIVE_DETAILS_KEY, DRIVE_DETAILS_TOGGLE_ID, driveDetailsPanel } from "@/features/drive/store/useDriveDetailsPanel"
import { DockedSidePanel, SidePanelSurface, type DockedSurfaceProps } from "@/features/shell/components/dockedSidePanel"
import { useIsSidePanelNarrow } from "@/features/shell/lib/sidePanelLayout"
import { Kbd } from "@/lib/keymap/kbd"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { useDebouncedValue } from "@/lib/useDebouncedValue"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"

interface DetailsSurfaceProps {
	items: DriveItem[]
	variant: DriveVariant
	// False until the selection has held still: nothing remote is read for a selection passed over.
	settled: boolean
	onDialogAction: DriveDialogAction
}

function DetailsSurface({
	items,
	variant,
	settled,
	onDialogAction,
	className,
	ref,
	onKeyDown,
	onClose
}: DetailsSurfaceProps & DockedSurfaceProps) {
	const { t } = useTranslation("drive")
	const [single] = items

	return (
		<SidePanelSurface
			controller={driveDetailsPanel}
			itemKey={DRIVE_DETAILS_KEY}
			title={items.length === 1 ? t("driveDetailsTitle") : t("driveDetailsSelectionTitle", { count: items.length })}
			keepSelection
			className={className}
			ref={ref}
			onKeyDown={onKeyDown}
			onClose={onClose}
		>
			{/* Keyed by the selection: one item's local state (versions shown, a pending removal) never carries over. */}
			<div
				key={selectionKey(items)}
				className="flex min-h-0 flex-1 scrollbar-gutter-stable flex-col gap-4 overflow-y-auto px-4 pb-4"
			>
				{items.length === 1 && single !== undefined ? (
					<ItemDetails
						item={single}
						variant={variant}
						remoteReady={settled}
						renderName={(name, className) => <p className={className}>{name}</p>}
						onOpenDialog={kind => {
							onDialogAction(kind, [single])
						}}
					/>
				) : (
					<SelectionDetails
						items={items}
						variant={variant}
						remoteReady={settled}
					/>
				)}
			</div>
		</SidePanelSurface>
	)
}

// Mounted by the listing with its selection: the listing's place for item details (its Info opens it). Nothing while
// nothing is selected; from the side panel breakpoint up the panel docks beside the listing unless the user closed
// it, below it the sheet opens from the toggle or Info only. `suspended` while one of the listing's dialogs covers it
// (the preview a double-click opens selects its item first): nothing is read for a panel no one sees.
export function DriveDetailsHost({
	items,
	variant,
	suspended,
	onDialogAction
}: Omit<DetailsSurfaceProps, "settled"> & { suspended: boolean }) {
	const { t } = useTranslation("drive")
	const key = selectionKey(items)
	const settled = useDebouncedValue(key, DETAILS_SETTLE_MS) === key && !suspended

	if (items.length === 0) {
		return null
	}

	return (
		<DockedSidePanel
			controller={driveDetailsPanel}
			itemKey={DRIVE_DETAILS_KEY}
			label={t("driveDetailsTitle")}
			renderSurface={surface => (
				<DetailsSurface
					items={items}
					variant={variant}
					settled={settled}
					onDialogAction={onDialogAction}
					{...surface}
				/>
			)}
		/>
	)
}

// The selection bar's toggle and its key: shows or hides the panel (the sheet below the breakpoint).
export function DriveDetailsToggle() {
	const { t } = useTranslation("drive")
	const narrow = useIsSidePanelNarrow()
	const open = driveDetailsPanel.useOpen(DRIVE_DETAILS_KEY, narrow)

	useAction(
		"drive.toggleDetails",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			driveDetailsPanel.toggle(DRIVE_DETAILS_KEY)
		},
		OUTSIDE_OVERLAYS
	)

	return (
		<TooltipIconButton
			id={DRIVE_DETAILS_TOGGLE_ID}
			label={t("driveDetailsTitle")}
			variant="outline"
			size="icon-sm"
			pressed={open}
			shortcut={<Kbd action="drive.toggleDetails" />}
			onClick={() => {
				driveDetailsPanel.toggle(DRIVE_DETAILS_KEY)
			}}
		>
			{narrow ? <InfoIcon /> : <PanelRightIcon />}
		</TooltipIconButton>
	)
}
