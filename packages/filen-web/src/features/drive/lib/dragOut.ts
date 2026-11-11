import { onlineManager } from "@tanstack/react-query"
import { toast } from "sonner"
import {
	DESKTOP_DRAG_IMAGE_LIMITS,
	type DesktopBridge,
	type DesktopDragImage,
	type DesktopDragOutcome,
	type DesktopDragPrepared,
	type DesktopDragRefusal
} from "@filen/shared/desktop"
import { i18n } from "@/lib/i18n"
import type { DriveItem } from "@/features/drive/lib/item"
import {
	cancelPointerDrag,
	handOffPointerDrag,
	pointerDragChip,
	resumePointerDrag,
	setPointerDragHooks
} from "@/features/drive/lib/pointerDrag"
import { startNativeDownloads } from "@/features/transfers/lib/nativeHost"
import { downloadItemOf } from "@/features/transfers/lib/nativeTransfers.logic"

// The desktop hand-off: a drive drag (pointerDrag.ts) leaving the window becomes an OS drag of those items. An in-app
// drag asks main for nothing; the first move outside the window prepares the items (main lists directories, Linux
// stages copies), and once they are ready a drag still held outside the window begins the OS drag. The page hears no pointer events
// while the OS drag runs; begin settles once it has ended, on every OS.

// OS file drags reaching the page this long after our own drag-out ended are its tail, never an upload.
const QUIET_AFTER_MS = 1000

// A drag-out counts as active at most this long (past main's own watchdog for an OS drag whose end never came), so an
// OS drag that never settles cannot keep the page refusing file drops.
export const DRAG_OUT_MAX_MS = 11 * 60_000

// One toast for every drag-out notice: a later one replaces it.
const DRAG_OUT_TOAST_ID = "drive.dragOut"

// How the in-app drag ended, as far as the hand-off cares: still held, dropped on a target, released elsewhere (outside
// the window: the user meant the drag out), or cancelled (Escape, a lost focus, an unseen release).
type Engine = "held" | "dropped" | "released" | "cancelled"

interface Attempt {
	items: readonly DriveItem[]
	chip: HTMLCanvasElement | null
	engine: Engine
	// The last move's place and buttons: a release outside is a drop outside the window.
	outside: boolean
	buttons: number
	// When it started asking main (Date.now()).
	since: number
	phase: "idle" | "preparing" | "prepared" | "beginning" | "done"
	id: string | null
	image: DesktopDragImage | null
}

let drag: DesktopBridge["drag"] | null = null
let attempt: Attempt | null = null
// Attempts asking main or handed to the OS.
const live = new Set<Attempt>()
let quietUntil = 0
// Ids main is still staging (Linux): begun now they would only answer notReady.
const staging = new Set<string>()

// True while a drag-out is being prepared or runs, and for a moment after: the page's own drag coming back over the
// window is no upload (isFileDrag).
export function dragOutActive(): boolean {
	const now = Date.now()

	for (const current of live) {
		if (now - current.since > DRAG_OUT_MAX_MS) {
			live.delete(current)
		}
	}

	return live.size > 0 || now < quietUntil
}

// Installs the hand-off for the desktop app's page; the returned function removes it.
export function installDragOut(bridge: Pick<DesktopBridge, "drag">): () => void {
	drag = bridge.drag

	// Listened for before any prepare: main sends an id's states only to the page that prepared it.
	const unsubscribe = bridge.drag.onState(state => {
		if (state.state === "staging") {
			staging.add(state.id)

			return
		}

		staging.delete(state.id)

		// Staged under a resting pointer: begin without waiting for a move.
		if (attempt?.id === state.id) {
			tryBegin(attempt)
		}
	})

	setPointerDragHooks({ onStart, onMove, onEnd })

	return () => {
		setPointerDragHooks(null)
		unsubscribe()
		staging.clear()
		live.clear()
		quietUntil = 0
		attempt = null
		drag = null
	}
}

function onStart(items: readonly DriveItem[]): void {
	attempt = {
		items,
		chip: pointerDragChip(),
		engine: "held",
		outside: false,
		buttons: 0,
		since: 0,
		phase: "idle",
		id: null,
		image: null
	}
}

function onMove(_point: unknown, outside: boolean, buttons: number): "continue" | "handedOff" {
	const current = attempt

	if (current === null || drag === null) {
		return "continue"
	}

	current.outside = outside
	current.buttons = buttons

	if (outside && current.phase === "idle") {
		prepare(current, drag)

		return "continue"
	}

	return startBegin(current) ? "handedOff" : "continue"
}

// Begins the OS drag when the items are ready and the drag is still held outside the window; true once begin is issued.
function startBegin(current: Attempt): boolean {
	if (
		drag === null ||
		current.phase !== "prepared" ||
		current.engine !== "held" ||
		!current.outside ||
		current.buttons === 0 ||
		current.id === null ||
		current.image === null ||
		staging.has(current.id)
	) {
		return false
	}

	begin(current, drag, current.id, current.image)

	return true
}

// startBegin outside onMove (prepared, or done staging, under a resting pointer): the engine is told here.
function tryBegin(current: Attempt): void {
	if (startBegin(current)) {
		handOffPointerDrag()
	}
}

function onEnd(dropped: boolean, released: boolean): void {
	const current = attempt

	if (current === null) {
		return
	}

	attempt = null
	current.engine = dropped ? "dropped" : released ? "released" : "cancelled"

	// Preparing or beginning: what they settle with decides. Unbegun, the id goes back to main.
	if (current.phase === "prepared") {
		releaseUnbegun(current)
	}
}

function prepare(current: Attempt, bridge: DesktopBridge["drag"]): void {
	if (!onlineManager.isOnline()) {
		refuse(current, { reason: "offline" })

		return
	}

	current.phase = "preparing"
	current.since = Date.now()
	live.add(current)

	const chip = current.chip

	void Promise.all([
		bridge
			.prepare({ items: current.items.map(downloadItemOf) })
			.catch((): DesktopDragPrepared => ({ refused: { reason: "unavailable" } })),
		chip === null ? Promise.resolve(null) : dragImageOf(chip).catch(() => null)
	]).then(([prepared, image]) => {
		if ("refused" in prepared) {
			finish(current)
			refuse(current, prepared.refused)

			return
		}

		current.id = prepared.id
		current.image = image
		current.phase = "prepared"

		// No image to show the OS: the drag cannot begin.
		if (image === null) {
			bridge.release(prepared.id)
			finish(current)
			refuse(current, { reason: "unavailable" })

			return
		}

		if (current.engine !== "held") {
			releaseUnbegun(current)
		} else {
			tryBegin(current)
		}
	})
}

function begin(current: Attempt, bridge: DesktopBridge["drag"], id: string, image: DesktopDragImage): void {
	current.phase = "beginning"

	void bridge
		.begin({ id, image })
		.catch((): DesktopDragOutcome => "failed")
		.then(outcome => {
			if (outcome !== "notReady") {
				finish(current)

				if (current.engine === "held") {
					cancelPointerDrag()
				}

				if (outcome === "failed") {
					notify(current, "driveDragOutUnavailable")
				}

				return
			}

			current.phase = "prepared"

			// Still held: back to the in-app drag, begun again once ready (a move outside or main's ready state).
			if (current.engine === "held") {
				resumePointerDrag()
				tryBegin(current)
			} else {
				releaseUnbegun(current)
			}
		})
		.finally(() => {
			// A handler that threw leaves no attempt counted as running.
			if (current.phase === "beginning") {
				finish(current)
			}
		})
}

// A prepared id the drag never began with: back to main, saying so when the user let go outside the window.
function releaseUnbegun(current: Attempt): void {
	if (current.id !== null) {
		drag?.release(current.id)
	}

	finish(current)

	if (current.engine === "released" && current.outside) {
		notify(current, "driveDragOutPreparing")
	}
}

// A refusal ends a held drag and says why; a drag already dropped in the page or cancelled hears nothing.
function refuse(current: Attempt, refusal: DesktopDragRefusal): void {
	current.phase = "done"

	if (current.engine === "held") {
		cancelPointerDrag()
	} else if (current.engine !== "released" || !current.outside) {
		return
	}

	switch (refusal.reason) {
		case "tooLarge":
			notify(current, "driveDragOutTooLarge")
			break
		case "tooMany":
			notify(current, "driveDragOutTooMany")
			break
		case "pathTooLong":
			notify(current, "driveDragOutPathTooLong")
			break
		case "offline":
			toast(i18n.t("drive:driveDragOutOffline"), { id: DRAG_OUT_TOAST_ID })
			break
		case "unavailable":
			notify(current, "driveDragOutUnavailable")
			break
	}
}

function finish(current: Attempt): void {
	if (live.delete(current)) {
		quietUntil = Date.now() + QUIET_AFTER_MS
	}

	current.phase = "done"
}

// The notice with a way out: the same items downloaded into a directory the user picks.
function notify(
	current: Attempt,
	key: "driveDragOutTooLarge" | "driveDragOutTooMany" | "driveDragOutPathTooLong" | "driveDragOutUnavailable" | "driveDragOutPreparing"
): void {
	toast(i18n.t(`drive:${key}`), {
		id: DRAG_OUT_TOAST_ID,
		action: {
			label: i18n.t("drive:driveDragOutDownloadTo"),
			onClick: () => {
				void startNativeDownloads([...current.items], { ask: true })
			}
		}
	})
}

// The chip as the OS drag image, encoded once per drag. Past the image's scale limit (a zoomed page on a dense screen)
// it is redrawn at that scale.
async function dragImageOf(chip: HTMLCanvasElement): Promise<DesktopDragImage | null> {
	const width = Number.parseFloat(chip.style.width) || chip.width
	const height = Number.parseFloat(chip.style.height) || chip.height
	let canvas = chip

	if (chip.width / width > DESKTOP_DRAG_IMAGE_LIMITS.scale) {
		canvas = document.createElement("canvas")
		canvas.width = Math.floor(width * DESKTOP_DRAG_IMAGE_LIMITS.scale)
		canvas.height = Math.floor(height * DESKTOP_DRAG_IMAGE_LIMITS.scale)
		canvas.getContext("2d")?.drawImage(chip, 0, 0, canvas.width, canvas.height)
	}

	const blob = await new Promise<Blob | null>(resolve => {
		canvas.toBlob(resolve, "image/png")
	})

	if (blob === null) {
		return null
	}

	return { png: new Uint8Array(await blob.arrayBuffer()), width, height, scale: canvas.width / width }
}
