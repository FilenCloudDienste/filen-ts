import { useState, type ReactNode } from "react"
import { type DriveItem } from "@/features/drive/lib/item"
import { useUploadMenuActions } from "@/features/drive/hooks/useUploadMenuActions"
import { NewDirectoryDialog } from "@/features/drive/components/newDirectory"
import { type DestinationActions } from "@/features/drive/components/destinationMenu"

export interface UseDirectoryDestinationParams {
	disabled: boolean
	openPreview: (items: DriveItem[], index: number) => void
	hiddenNotice: boolean
	testIdPrefix: string
}

export interface DirectoryDestination {
	// The create and upload actions, pointed at one directory (null for My Drive's root).
	actionsFor: (uuid: string | null) => DestinationActions
	// A picker or a name dialog is in use, so the host has to stay mounted until it settles.
	busy: boolean
	// The hidden pickers and both name dialogs. Mounted beside the menus, never inside a popup: a popup
	// unmounts on close, before a picker's change or a dialog's submit arrives.
	host: ReactNode
}

// One host for every directory a surface's menus can create or upload into — a listing's own directory
// and each of its directory rows, or whichever sidebar tree node was right-clicked. An action first
// points the host at its directory; a picker's change and a dialog's submit arrive after that render,
// so they land there.
export function useDirectoryDestination({
	disabled,
	openPreview,
	hiddenNotice,
	testIdPrefix
}: UseDirectoryDestinationParams): DirectoryDestination {
	const [target, setTarget] = useState<string | null>(null)
	const [newDirectoryOpen, setNewDirectoryOpen] = useState(false)
	const upload = useUploadMenuActions({ parentUuid: target, disabled, openPreview, hiddenNotice, testIdPrefix })

	return {
		actionsFor: uuid => ({
			newDirectory: () => {
				setTarget(uuid)
				setNewDirectoryOpen(true)
			},
			newTextFile: () => {
				setTarget(uuid)
				upload.newTextFile()
			},
			pickFiles: () => {
				setTarget(uuid)
				upload.pickFiles()
			},
			pickDirectory: () => {
				setTarget(uuid)
				upload.pickDirectory()
			}
		}),
		busy: upload.busy || newDirectoryOpen,
		host: (
			<>
				{upload.host}
				<NewDirectoryDialog
					open={newDirectoryOpen}
					onOpenChange={setNewDirectoryOpen}
					parentUuid={target}
					hiddenNotice={hiddenNotice}
				/>
			</>
		)
	}
}
