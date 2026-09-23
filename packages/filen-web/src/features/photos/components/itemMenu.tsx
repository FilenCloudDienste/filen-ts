import { createElement, Fragment } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { type ItemActionDescriptor, type ItemActionDialogKind, type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import { applyOfflineGate, startItemDownload } from "@/features/drive/components/itemMenu.logic"
import { photosItemActions } from "@/features/photos/lib/itemActions"
import { toggleFavoritePhoto } from "@/features/photos/lib/actions"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { ContextMenuContent } from "@/components/ui/context-menu"
import { DropdownMenuContent } from "@/components/ui/dropdown-menu"
import { CopySubmenu } from "@/features/drive/components/copySubmenu"
import {
	CONTEXT_TREE_MENU_FAMILY,
	DROPDOWN_TREE_MENU_FAMILY,
	type DirectoryTreeMenuFamily
} from "@/features/drive/components/directoryTreeSubmenu"

export interface PhotosItemMenuContentProps {
	rootUuid: string
	item: PhotoItem
	// Fires for every "dialog"-run descriptor (rename/copy/versions/info/link/share/trash) — the grid's own
	// dialog host (usePhotosDialogHost) owns turning this into an open dialog. "favorite" (the only
	// "direct"-run descriptor photosItemActions ever produces) never reaches here — it resolves fully
	// in place below, mirroring the drive item menu's identical favorite/restore split.
	onItemAction: (kind: ItemActionDialogKind, item: PhotoItem) => void
}

const SEPARATOR_BEFORE = new Set<ItemActionId>(["info", "trash"])

// Shared per-item action list for the photos surface, rendered by BOTH the right-click context menu
// and the ⋯ dropdown — mirrors drive's own itemMenu.tsx ItemMenuEntries split (one descriptor list,
// one family-parameterized row renderer) against photosItemActions' smaller, fixed descriptor set
// instead of driveItemActions' variant dispatch.
function PhotosItemMenuEntries({ rootUuid, item, onItemAction, family }: PhotosItemMenuContentProps & { family: DirectoryTreeMenuFamily }) {
	const { t } = useTranslation(["drive", "photos", "common"])
	const isOnline = useIsOnline()
	const descriptors = applyOfflineGate(photosItemActions(item), isOnline)
	const { Item, Separator } = family

	async function runDirect(descriptor: Extract<ItemActionDescriptor, { run: "direct" }>): Promise<void> {
		// Checked FIRST, before any `await` — startItemDownload's FSA save picker needs this click's
		// own live user gesture, mirrors drive's itemMenu.tsx identical ordering.
		if (descriptor.id === "download") {
			startItemDownload(item)
			return
		}

		// "favorite" is the only remaining "direct" id photosItemActions ever produces.
		const outcome = await toggleFavoritePhoto(rootUuid, item)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	return (
		<>
			{descriptors.map((descriptor, index) => (
				<Fragment key={descriptor.id}>
					{index > 0 && SEPARATOR_BEFORE.has(descriptor.id) ? <Separator /> : null}
					{/* Drive's Copy submenu as is: it opens offline for its clipboard entry and gates its own
					    destinations, so the descriptor's offline flag is not applied to the trigger. */}
					{descriptor.id === "copy" ? (
						<CopySubmenu
							family={family}
							items={[item]}
							onChooseDestination={() => {
								onItemAction("copy", item)
							}}
						/>
					) : (
						<Item
							variant={descriptor.destructive ? "destructive" : "default"}
							disabled={descriptor.enabled === false}
							title={descriptor.enabled === false && !isOnline ? t("common:offlineActionDisabled") : undefined}
							onClick={event => {
								// The ⋯ dropdown is mounted as a React descendant of the tile's own clickable div —
								// see drive's itemMenu.tsx identical comment for why this stopPropagation is needed.
								event.stopPropagation()

								if (descriptor.run === "direct") {
									void runDirect(descriptor)
									return
								}

								onItemAction(descriptor.dialogKind, item)
							}}
						>
							{createElement(descriptor.icon, { "aria-hidden": true })}
							{t(descriptor.labelKey)}
						</Item>
					)}
				</Fragment>
			))}
		</>
	)
}

export function PhotosContextMenuContent(props: PhotosItemMenuContentProps) {
	return (
		<ContextMenuContent>
			<PhotosItemMenuEntries
				{...props}
				family={CONTEXT_TREE_MENU_FAMILY}
			/>
		</ContextMenuContent>
	)
}

export function PhotosDropdownMenuContent(props: PhotosItemMenuContentProps) {
	return (
		<DropdownMenuContent align="end">
			<PhotosItemMenuEntries
				{...props}
				family={DROPDOWN_TREE_MENU_FAMILY}
			/>
		</DropdownMenuContent>
	)
}
