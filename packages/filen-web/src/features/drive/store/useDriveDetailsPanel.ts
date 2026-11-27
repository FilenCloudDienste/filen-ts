import { type } from "arktype"
import { createSidePanelController } from "@/features/shell/lib/sidePanelStore"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"
import { type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { selectionKey } from "@/features/drive/components/itemDetails.logic"

// Mounted at most once (inline beside the listing, or in the sheet), so the fixed ids are unique.
export const DRIVE_DETAILS_PANEL_ID = "drive-details-panel"
export const DRIVE_DETAILS_TOGGLE_ID = "drive-details-toggle"
// The sheet's item key: one panel for whatever is selected, so it never closes itself on a selection change.
export const DRIVE_DETAILS_KEY = "selection"

// The listing's details panel: shown beside the listing while anything is selected, unless the user closed it. That
// choice is kept on this device and read at boot (lib/sdk/boot.ts), so a first selection lays the row out as the user
// left it. Below the side panel breakpoint the panel is a sheet opened only from its toggle, never by a selection.
export const driveDetailsPanel = createSidePanelController({
	panelId: DRIVE_DETAILS_PANEL_ID,
	returnFocusId: DRIVE_DETAILS_TOGGLE_ID
})

const preference = preloadedPreference({
	key: "drive.detailsPanelOpen.v1",
	schema: type("boolean"),
	fallback: true,
	scope: "drive",
	same: (a, b) => a === b
})

driveDetailsPanel.useStore.setState({ panelOpen: preference.get() })

driveDetailsPanel.useStore.subscribe((state, previous) => {
	if (state.panelOpen !== previous.panelOpen) {
		preference.set(state.panelOpen)
	}
})

export async function loadDriveDetailsPanelOpen(): Promise<void> {
	await preference.load()
	driveDetailsPanel.useStore.setState({ panelOpen: preference.get() })
}

// The listing's Info: selects what it was offered for (a row's menu or the cursor row may lie outside the selection)
// and opens the panel on it, or the sheet below the breakpoint. Focus moves into it.
export function openDriveDetails(items: DriveItem[]): void {
	const store = useDriveStore.getState()

	if (selectionKey(store.selectedItems) !== selectionKey(items)) {
		store.setSelectedItems(items)
	}

	driveDetailsPanel.open(DRIVE_DETAILS_KEY)
}
