import { type DragEvent } from "react"
import { i18n } from "@/lib/i18n"
import { canDragVariant, assembleDragPayload } from "@/features/drive/lib/dnd.logic"
import { moveItems } from "@/features/drive/lib/actions"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"

// Custom dataTransfer type marking an INTERNAL move drag. The dropzone (external file upload) checks
// for it to BOW OUT entirely, and every move drop target requires it before treating a drop as a
// move — the one signal that keeps drag-to-move and drop-to-upload from ever colliding. The value is
// irrelevant; the presence of the TYPE is the marker (dataTransfer.getData is unreadable mid-drag
// anyway, so the real payload rides the module ref below, not the transfer).
export const INTERNAL_DRAG_TYPE = "application/x-filen-move"

// Module-level payload — the live DriveItem[] currently being dragged, kept here for object identity
// because dataTransfer only carries strings. Mirrors the old web app's module-level dragged-items
// array. Set on dragstart, read by every drop target's validity check + drop, cleared on dragend.
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

// True while a drag carries our internal-move marker. Read during dragenter/over/leave — where only
// `dataTransfer.types` is exposed, never the data itself — so the upload dropzone can ignore an
// internal drag and a move target can ignore an external file drag.
export function isInternalDrag(dataTransfer: DataTransfer | null): boolean {
	return dataTransfer?.types.includes(INTERNAL_DRAG_TYPE) ?? false
}

function dragImageLabel(items: readonly DriveItem[]): string {
	if (items.length === 1) {
		const only = items[0]

		return only?.data.decryptedMeta?.name ?? only?.data.uuid ?? ""
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

// A self-contained chip drawn on an off-DOM canvas: a solid dark pill with light text, legible over
// either theme's page background (it carries its own colors, never inheriting the page's). Single
// drag shows the item name; a multi drag shows an "{count} items" badge. Attached off-screen only
// long enough for the browser to snapshot it (setDragImage copies synchronously), then removed.
function applyDragImage(dataTransfer: DataTransfer, items: readonly DriveItem[]): void {
	const canvas = document.createElement("canvas")
	const ctx = canvas.getContext("2d")

	if (!ctx) {
		return
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
	canvas.style.position = "fixed"
	canvas.style.top = "-1000px"
	canvas.style.left = "-1000px"
	canvas.style.pointerEvents = "none"

	ctx.scale(dpr, dpr)
	ctx.fillStyle = "rgba(24, 24, 27, 0.95)"
	roundRectPath(ctx, width, height, radius)
	ctx.fill()
	ctx.fillStyle = "#fafafa"
	ctx.font = font
	ctx.textBaseline = "middle"
	ctx.fillText(text, paddingX, height / 2 + 1)

	document.body.appendChild(canvas)
	dataTransfer.setDragImage(canvas, paddingX, height / 2)
	requestAnimationFrame(() => {
		canvas.remove()
	})
}

export interface DragSourceProps {
	draggable: true
	onDragStart: (event: DragEvent<HTMLElement>) => void
	onDragEnd: () => void
}

// Drag-source props for a move-capable row/tile, or undefined when the variant can't drag (the row
// renders non-draggable). Reading the selection from the store at dragstart (not via a subscription)
// keeps rows from re-rendering on every selection change. Pointer-only affordance — the accessible
// move route stays the item menu's "Move" action (opens the destination picker); see the row/tile
// draggable wiring.
export function buildDragSourceProps(item: DriveItem, variant: DriveVariant): DragSourceProps | undefined {
	if (!canDragVariant(variant)) {
		return undefined
	}

	return {
		draggable: true,
		onDragStart: event => {
			const selectedItems = useDriveStore.getState().selectedItems
			const selectedUuids = new Set(selectedItems.map(selected => selected.data.uuid))
			const dragged = assembleDragPayload(item, selectedUuids, selectedItems)

			// Dragging an unselected item selects just it, so the drag and the visible selection agree.
			if (!selectedUuids.has(item.data.uuid)) {
				useDriveStore.getState().setSelectedItems([item])
			}

			setDragPayload(dragged)
			event.dataTransfer.effectAllowed = "move"
			event.dataTransfer.setData(INTERNAL_DRAG_TYPE, "1")
			applyDragImage(event.dataTransfer, dragged)
		},
		onDragEnd: () => {
			clearDragPayload()
		}
	}
}

// Runs the move for a completed drop. Reuses moveItems' existing confirm-then-patch machinery (both
// source and destination listings, cancel-in-flight already inside driveListingQueryUpdate) and the
// standard bulk toast; a rejection surfaces there via errorLabel. Detaches the payload from the
// module ref before awaiting so a concurrent dragend clear can't mutate it mid-op.
export async function performMove(items: readonly DriveItem[], targetUuid: string | null): Promise<void> {
	if (items.length === 0) {
		return
	}

	const moved = items.slice()
	const outcome = await moveItems(moved, targetUuid)

	toastBulkOutcome(outcome)
	useDriveStore.getState().removeFromSelection(outcome.succeeded.map(item => item.data.uuid))
}
