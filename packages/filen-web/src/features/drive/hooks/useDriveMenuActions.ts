import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import {
	driveSelectionActions,
	type DriveActionDescriptor,
	type DriveActionId,
	type DriveActionShortcuts
} from "@/features/drive/lib/selectionActions"
import { useIsOnline } from "@/lib/useIsOnline"

export interface DriveMenuActionsParams {
	items: DriveItem[]
	variant: DriveVariant
	hiddenActionIds?: ReadonlySet<DriveActionId> | undefined
	searchHit?: boolean | undefined
	onOpen?: (() => void) | undefined
	shortcuts?: DriveActionShortcuts | undefined
}

// The entries a menu over `items` lists, as every drive surface builds them.
export function useDriveMenuActions(params: DriveMenuActionsParams): DriveActionDescriptor[] {
	const isOnline = useIsOnline()

	return driveSelectionActions(params.items, params.variant, {
		isOnline,
		searchHit: params.searchHit,
		open: params.onOpen !== undefined,
		shortcuts: params.shortcuts
	}).filter(descriptor => params.hiddenActionIds?.has(descriptor.id) !== true)
}
