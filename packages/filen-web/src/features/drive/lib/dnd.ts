import { type PointerEvent } from "react"
import { driveItemName } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { canDragVariant, assembleDragPayload } from "@/features/drive/lib/dnd.logic"
import { pressPointerDrag } from "@/features/drive/lib/pointerDrag"
import { moveItems } from "@/features/drive/lib/actions"
import { confirmDotFilenOperation, includesRootDotFilen } from "@/features/drive/lib/dotFilenGuard"
import { type BulkOutcome } from "@/lib/actions/bulk"
import { runBulkActivity, type BulkActivitySpec } from "@/lib/activity/activity"
import { DRIVE_MOVE, driveActivity } from "@/features/drive/lib/activity"
import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { reconcileSelectedItems } from "@/features/drive/components/directoryListing.logic"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"

// Module-level payload — the live DriveItem[] currently being dragged (pointerDrag.ts), kept as the
// items themselves for object identity. Mirrors the old web app's module-level dragged-items array. Set
// when a press becomes a drag, read by every drop target's validity check + drop, cleared when it ends.
let payload: readonly DriveItem[] = []

export function setDragPayload(items: readonly DriveItem[]): void {
	payload = items
}

export function getDragPayload(): readonly DriveItem[] {
	return payload
}

export function clearDragPayload(): void {
	payload = []
}

function dragImageLabel(items: readonly DriveItem[]): string {
	if (items.length === 1) {
		const only = items[0]

		return only ? driveItemName(only) : ""
	}

	return i18n.t("drive:driveDragItemCount", { count: items.length })
}

function roundRectPath(ctx: CanvasRenderingContext2D, width: number, height: number, radius: number): void {
	ctx.beginPath()
	ctx.moveTo(radius, 0)
	ctx.arcTo(width, 0, width, height, radius)
	ctx.arcTo(width, height, 0, height, radius)
	ctx.arcTo(0, height, 0, 0, radius)
	ctx.arcTo(0, 0, width, 0, radius)
	ctx.closePath()
}

// A self-contained chip drawn once per drag on a canvas the drag engine moves with the pointer: a solid
// dark pill with light text, legible over either theme's page background (it carries its own colors,
// never inheriting the page's). Single drag shows the item name; a multi drag shows an "{count} items"
// badge.
function drawDragChip(items: readonly DriveItem[]): HTMLCanvasElement | null {
	const canvas = document.createElement("canvas")
	const ctx = canvas.getContext("2d")

	if (!ctx) {
		return null
	}

	const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
	const font = "600 13px ui-sans-serif, system-ui, -apple-system, sans-serif"
	const paddingX = 14
	const height = 30
	const radius = height / 2
	const maxTextWidth = 260

	ctx.font = font
	const rawText = dragImageLabel(items)
	let text = rawText

	// Truncate an over-long single-item name so the chip never runs off-screen.
	if (ctx.measureText(text).width > maxTextWidth) {
		while (text.length > 1 && ctx.measureText(`${text}…`).width > maxTextWidth) {
			text = text.slice(0, -1)
		}

		text = `${text}…`
	}

	const width = Math.ceil(ctx.measureText(text).width) + paddingX * 2

	canvas.width = Math.ceil(width * dpr)
	canvas.height = Math.ceil(height * dpr)
	canvas.style.width = `${String(width)}px`
	canvas.style.height = `${String(height)}px`

	ctx.scale(dpr, dpr)
	ctx.fillStyle = "rgba(24, 24, 27, 0.95)"
	roundRectPath(ctx, width, height, radius)
	ctx.fill()
	ctx.fillStyle = "#fafafa"
	ctx.font = font
	ctx.textBaseline = "middle"
	ctx.fillText(text, paddingX, height / 2 + 1)

	return canvas
}

export interface DragSourceProps {
	onPointerDown: (event: PointerEvent<HTMLElement>) => void
}

// The press every drive drag source shares: once it becomes a drag (pointerDrag.ts), `resolve` names the
// items, which ride the payload ref until the drag ends.
function pressDragSource(event: PointerEvent<HTMLElement>, resolve: () => readonly DriveItem[] | undefined): void {
	pressPointerDrag(event, {
		start: () => {
			const items = resolve()

			if (items !== undefined) {
				setDragPayload(items)
			}

			return items
		},
		chip: drawDragChip,
		end: clearDragPayload
	})
}

// Drag-source props for a move-capable row/tile, or undefined when the variant can't drag. The selection
// is read from the store once the press becomes a drag, each item as `current` (the listing's reconciled
// selection) now has it: a move re-encrypts the passed item's name for the destination's shares and
// links. Pointer-only affordance (mouse and pen; touch long-presses to select) — the accessible move
// route stays the item menu's "Move" action (opens the destination picker).
export function buildDragSourceProps(item: DriveItem, variant: DriveVariant, current: DriveItem[]): DragSourceProps | undefined {
	if (!canDragVariant(variant)) {
		return undefined
	}

	return {
		onPointerDown: event => {
			pressDragSource(event, () => {
				const selectedItems = reconcileSelectedItems(useDriveStore.getState().selectedItems, current)
				const selectedUuids = new Set(selectedItems.map(selected => selected.data.uuid))

				// Dragging an unselected item selects just it, so the drag and the visible selection agree.
				if (!selectedUuids.has(item.data.uuid)) {
					useDriveStore.getState().setSelectedItems([item])
				}

				return assembleDragPayload(item, selectedUuids, selectedItems)
			})
		}
	}
}

// Drag-source props for a sidebar tree node: it drags its own directory alone, leaving the listing's
// selection alone. The item is resolved once the press becomes a drag (a cached listing read); a node
// whose row isn't cached starts no drag, since nothing could drop it.
export function buildTreeDragSourceProps(resolveItem: () => DriveItem | undefined): DragSourceProps {
	return {
		onPointerDown: event => {
			pressDragSource(event, () => {
				const item = resolveItem()

				return item === undefined ? undefined : [item]
			})
		}
	}
}

// A move of items into a directory as an activity, named by where they go.
export function moveActivity(items: readonly DriveItem[], destination: CopyDestination): BulkActivitySpec<DriveItem> {
	return driveActivity(items, DRIVE_MOVE, (targets, onSettled) => moveItems(targets, destination.uuid, onSettled), {
		// A destination whose name isn't cached (a tree level never listed) still reads as a sentence.
		values: { destination: destination.name === "" ? i18n.t("drive:driveMoveDestinationFallback") : destination.name }
	})
}

// Runs the move for a completed drop, a pick in the item menu's directory tree (transferSubmenu.tsx) or
// a pasted cut (clipboard.ts), as an activity toast; the move dialog (moveTargetDialog.tsx) runs
// moveActivity itself. Moving the root `.filen` asks for its name first (lib/dotFilenGuard.ts) unless the caller
// already did (`confirmed`); a cancel moves nothing.
export async function performMove(
	items: readonly DriveItem[],
	destination: CopyDestination,
	confirmed?: boolean
): Promise<BulkOutcome<DriveItem>> {
	if (items.length === 0 || (confirmed !== true && includesRootDotFilen(items) && !(await confirmDotFilenOperation("move", items)))) {
		return { succeeded: [], failed: [] }
	}

	return await runBulkActivity(moveActivity(items, destination))
}
