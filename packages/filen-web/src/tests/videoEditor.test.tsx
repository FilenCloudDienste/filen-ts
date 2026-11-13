// @vitest-environment jsdom

import { isMacPlatform } from "@filen/shared/keymap"
import { createRef } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import "@/lib/i18n"
import type { DriveItem } from "@/features/drive/lib/item"
import type { ExportPlan, VideoEditRecipe, VideoSourceInfo } from "@/features/preview/videoEdit/types"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { registerAction } from "@/lib/keymap/registry"
import { fakeVideoEditClient } from "@/tests/support/fakeVideoEditClient"

// The video editor over a fake client: the Save popover says what the plan says (fast or re-encode, size and time,
// drops, HDR, the original's fate, the targets in the plan's order, options this browser cannot do disabled), a
// snapped cut shows its chip and Make precise asks for precise cuts, the trim handles step a frame, a second and to
// their bounds from the keyboard, Mod+Z and Mod+Shift+Z undo and redo, an export shows its progress and continues in the
// background as a transfer, a failed one retries with the same edits, and offline nothing can be saved.

const state = vi.hoisted(() => ({ online: true }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => state.online }))
vi.mock("@/features/preview/hooks/usePreviewVideo", () => ({ usePreviewVideo: () => ({ controller: null, snapshot: null }) }))

const { VideoEditor } = await import("@/features/preview/videoEdit/components/videoEditor")

type VideoEditorCommands = NonNullable<Parameters<typeof VideoEditor>[0]["commandsRef"]["current"]>

const ITEM = { type: "file", data: { uuid: "video-1" } } as unknown as DriveItem
const COPY = { type: "file", data: { uuid: "copy-1" } } as unknown as DriveItem

class FakeResizeObserver {
	observe = vi.fn()
	unobserve = vi.fn()
	disconnect = vi.fn()
}

function mount(options: { info?: Partial<VideoSourceInfo>; planFor?: (recipe: VideoEditRecipe) => Partial<ExportPlan> } = {}) {
	const fake = fakeVideoEditClient(options)
	const onDirtyChange = vi.fn()
	const onExit = vi.fn()
	const onSaveStarted = vi.fn()
	const onSaveSettled = vi.fn()
	const onCancel = vi.fn()
	const onSaveFrame = vi.fn(() => Promise.resolve("clip.jpg"))
	const commandsRef = createRef<VideoEditorCommands | null>()
	const view = render(
		<VideoEditor
			client={fake.client}
			info={fake.info}
			item={ITEM}
			name="clip.mp4"
			title="clip.mp4"
			onDirtyChange={onDirtyChange}
			onCancel={onCancel}
			onExit={onExit}
			onSaveStarted={onSaveStarted}
			onSaveSettled={onSaveSettled}
			onSaveFrame={onSaveFrame}
			commandsRef={commandsRef}
		/>
	)
	const root = view.container.querySelector<HTMLElement>("[data-preview-surface]")

	if (root === null) {
		throw new Error("no editor root")
	}

	return { ...fake, onDirtyChange, onExit, onSaveStarted, onSaveSettled, onCancel, onSaveFrame, commandsRef, view, root }
}

function lastPlanned(plans: readonly VideoEditRecipe[]): VideoEditRecipe {
	const recipe = plans.at(-1)

	if (recipe === undefined) {
		throw new Error("nothing planned")
	}

	return recipe
}

function startHandle(): HTMLElement {
	return screen.getByRole("slider", { name: "Start of part 1" })
}

// Trims a frame off the start, which makes the editor dirty.
function trimAFrame(): void {
	fireEvent.keyDown(startHandle(), { key: "ArrowRight" })
}

async function openSave(): Promise<HTMLElement> {
	const trigger = screen.getAllByRole("button", { name: "Save" })[0]

	if (trigger === undefined) {
		throw new Error("no Save")
	}

	fireEvent.click(trigger)

	return await screen.findByRole("dialog")
}

const mac = isMacPlatform()

function modKey(root: HTMLElement, key: string, shift = false): void {
	fireEvent.keyDown(root, { key, code: `Key${key.toUpperCase()}`, ctrlKey: !mac, metaKey: mac, shiftKey: shift })
}

beforeAll(() => {
	for (const def of PREVIEW_ACTIONS) {
		registerAction(def)
	}
})

beforeEach(() => {
	state.online = true
	toast.success.mockClear()
	toast.error.mockClear()
	vi.stubGlobal("ResizeObserver", FakeResizeObserver)
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
	HTMLMediaElement.prototype.pause = vi.fn()
	HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
	Element.prototype.setPointerCapture = vi.fn()
	Element.prototype.releasePointerCapture = vi.fn()
	Element.prototype.hasPointerCapture = vi.fn(() => true)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("VideoEditor", () => {
	it("marks its root as a preview surface and plans the untouched recipe", async () => {
		const { plans, onDirtyChange } = mount()

		await waitFor(() => {
			expect(plans.length).toBeGreaterThan(0)
		})

		expect(lastPlanned(plans).keep).toEqual([{ start: 0, end: 100 }])
		expect(onDirtyChange).not.toHaveBeenCalled()
		expect(screen.getAllByRole("button", { name: "Save" })[0]).toHaveProperty("disabled", true)
	})

	it("trims from the keyboard a frame, a second, and to the bound at a time", async () => {
		const { plans, onDirtyChange } = mount()

		trimAFrame()

		await waitFor(() => {
			expect(lastPlanned(plans).keep[0]?.start).toBeCloseTo(0.04)
		})
		expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		expect(startHandle().getAttribute("aria-valuetext")).toBe("00:00.04")

		fireEvent.keyDown(startHandle(), { key: "ArrowRight", shiftKey: true })
		expect(startHandle().getAttribute("aria-valuetext")).toBe("00:01.04")

		fireEvent.keyDown(startHandle(), { key: "PageUp" })
		expect(startHandle().getAttribute("aria-valuetext")).toBe("00:11.04")

		const end = screen.getByRole("slider", { name: "End of part 1" })

		fireEvent.keyDown(end, { key: "Home" })
		// The end stops a minimum length after the start.
		expect(end.getAttribute("aria-valuetext")).toBe("00:11.14")
	})

	it("undoes and redoes with Mod+Z and Mod+Shift+Z, and Revert goes back to the original", async () => {
		const { root, onDirtyChange } = mount()

		trimAFrame()
		await new Promise(resolve => setTimeout(resolve, 600))
		fireEvent.keyDown(startHandle(), { key: "ArrowRight", shiftKey: true })
		expect(startHandle().getAttribute("aria-valuetext")).toBe("00:01.04")

		modKey(root, "z")
		expect(startHandle().getAttribute("aria-valuetext")).toBe("00:00.04")

		modKey(root, "z")
		expect(startHandle().getAttribute("aria-valuetext")).toBe("00:00.00")
		expect(onDirtyChange).toHaveBeenLastCalledWith(false)

		modKey(root, "z", true)
		expect(startHandle().getAttribute("aria-valuetext")).toBe("00:00.04")

		fireEvent.click(screen.getByRole("button", { name: "Revert" }))
		expect(startHandle().getAttribute("aria-valuetext")).toBe("00:00.00")
	})

	it("summarises the plan in the Save popover, targets in the plan's order", async () => {
		mount({
			info: { hasLocation: true },
			planFor: () => ({
				mode: "transcode",
				dropped: ["subtitles", "chapters", "location"],
				hdr: "toSdr",
				targets: ["copy", "inPlace"],
				unavailable: ["resize"],
				estimateBytes: 120 * 1024 * 1024,
				estimateSeconds: 185
			})
		})

		trimAFrame()

		const popover = await openSave()

		await within(popover).findByText("Re-encode")
		expect(within(popover).getByText(/about 3 min/)).toBeTruthy()
		expect(within(popover).getByText("Subtitles and chapters removed")).toBeTruthy()
		expect(within(popover).getByText("Location removed")).toBeTruthy()
		expect(within(popover).getByText("HDR will be converted to SDR")).toBeTruthy()
		expect(within(popover).getByText("Versions are off: Save replaces the original for good.")).toBeTruthy()
		expect(within(popover).getByRole("button", { name: "1080p" })).toHaveProperty("disabled", true)
		expect(within(popover).getByRole("button", { name: "Original" })).toHaveProperty("disabled", false)
		expect(within(popover).getByText("Remove location")).toBeTruthy()

		const actions = within(popover)
			.getAllByRole("button")
			.map(button => button.textContent)
			.filter(text => text === "Save" || text === "Save as copy")

		expect(actions).toEqual(["Save as copy", "Save"])
	})

	it("calls a fast save fast and keeps the previous version", async () => {
		mount()

		trimAFrame()

		const popover = await openSave()

		await within(popover).findByText("Fast – no re-encode")
		expect(within(popover).getByText("Previous version kept in Versions")).toBeTruthy()
	})

	it("shows where a fast cut snaps and makes it precise on request", async () => {
		const { plans } = mount({
			planFor: recipe => (recipe.precise ? { mode: "transcode", snapped: [] } : { snapped: [{ requested: 10, actual: 12.1 }] })
		})

		const chip = await screen.findByText("Snaps 2.1 s later")

		expect(chip).toBeTruthy()
		expect(document.querySelector("[data-snap-ghost]")).not.toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Make precise" }))

		await waitFor(() => {
			expect(lastPlanned(plans).precise).toBe(true)
		})
		await waitFor(() => {
			expect(screen.queryByText("Snaps 2.1 s later")).toBeNull()
		})
	})

	it("disables what this browser cannot save, saying why", async () => {
		mount({ planFor: () => ({ unavailable: ["adjust", "speed"] }) })

		await waitFor(() => {
			expect(screen.getByRole("tab", { name: "Adjust" })).toBeTruthy()
		})
		fireEvent.click(screen.getByRole("tab", { name: "Adjust" }))
		await screen.findByText("Not available in this browser")

		const panel = screen.getByRole("tabpanel")

		const sliders = panel.querySelectorAll('[data-slot="slider"]')

		expect(sliders.length).toBeGreaterThan(0)

		for (const slider of sliders) {
			expect(slider.hasAttribute("data-disabled")).toBe(true)
		}

		fireEvent.click(screen.getByRole("tab", { name: "Speed" }))
		expect(screen.getByRole("button", { name: "2×" })).toHaveProperty("disabled", true)
	})

	it("says that colour work saves an HDR video as SDR", async () => {
		mount({ info: { transfer: "hlg", bitDepth: 10 }, planFor: () => ({ hdr: "toSdr" }) })

		fireEvent.click(screen.getByRole("tab", { name: "Adjust" }))

		expect(await screen.findByText("Colour changes save this HDR video as SDR.")).toBeTruthy()
	})

	it("offers to export without audio when only the sound blocks the save", async () => {
		const { plans } = mount({
			planFor: recipe => (recipe.audio.mute ? {} : { blockers: ["audioCodec"], mutingUnblocks: true })
		})

		trimAFrame()

		const popover = await openSave()

		expect(await within(popover).findByText("This browser can't re-encode this video's sound.")).toBeTruthy()
		expect(within(popover).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true)

		fireEvent.click(within(popover).getByRole("button", { name: "Export without audio" }))

		await waitFor(() => {
			expect(lastPlanned(plans).audio.mute).toBe(true)
		})
		await waitFor(() => {
			expect(within(popover).getByRole("button", { name: "Save" })).toHaveProperty("disabled", false)
		})
	})

	it("blocks a save the picture cannot be re-encoded for, without a way out through the sound", async () => {
		mount({ planFor: () => ({ blockers: ["crop"], mutingUnblocks: false }) })

		trimAFrame()

		const popover = await openSave()

		expect(await within(popover).findByText("This browser can't re-encode the picture, which these edits need.")).toBeTruthy()
		expect(within(popover).queryByRole("button", { name: "Export without audio" })).toBeNull()
	})

	it("words a refused save and offers Retry only where it can help", async () => {
		const { exports, client } = mount()

		trimAFrame()
		fireEvent.click(await within(await openSave()).findByRole("button", { name: "Save" }))

		await act(async () => {
			exports[0]?.settle({ status: "refused", reason: "quota", message: "MaxStorageReached" })
			await Promise.resolve()
		})

		expect(screen.getByText("Not enough storage left for the saved video.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Retry" }))
		expect(client.exportVideo).toHaveBeenCalledTimes(2)

		await act(async () => {
			exports[1]?.settle({ status: "refused", reason: "codec", message: "audio track 1 cannot be decoded" })
			await Promise.resolve()
		})

		expect(screen.getByText("This video's format can't be saved in this browser.")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
	})

	it("asks when the file changed elsewhere before the save, and saves a copy on request", async () => {
		const { exports, onSaveSettled } = mount()

		trimAFrame()
		fireEvent.click(await within(await openSave()).findByRole("button", { name: "Save" }))

		await act(async () => {
			exports[0]?.settle({ status: "remoteChanged", currentUuid: "newer" })
			await Promise.resolve()
		})

		expect(onSaveSettled).toHaveBeenCalledWith(null, "inPlace")

		const dialog = await screen.findByRole("alertdialog")

		fireEvent.click(within(dialog).getByRole("button", { name: /copy/i }))

		expect(exports[1]?.target).toBe("copy")
		expect(screen.queryByRole("alertdialog")).toBeNull()
	})

	it("shows the export's progress and continues it in the background", async () => {
		const { exports, onExit, onDirtyChange } = mount()

		trimAFrame()

		const popover = await openSave()
		const save = await within(popover).findByRole("button", { name: "Save" })

		fireEvent.click(save)

		const running = exports[0]

		expect(running?.target).toBe("inPlace")
		expect(running?.recipe.keep[0]?.start).toBeCloseTo(0.04)

		act(() => {
			running?.progress({ fraction: 0.54, bytesWritten: 1000, etaSeconds: 180 })
		})

		expect(screen.getByText(/Exporting… 54%/)).toBeTruthy()
		expect(screen.getByText(/about 3 min/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Continue in background" }))

		expect(running?.detachToTransfer).toHaveBeenCalledTimes(1)
		expect(onExit).toHaveBeenCalledTimes(1)
		expect(onDirtyChange).toHaveBeenLastCalledWith(false)

		await act(async () => {
			running?.settle({ status: "done", item: ITEM })
			await Promise.resolve()
		})

		expect(toast.success).toHaveBeenCalledWith("Saved clip.mp4")
	})

	it("hands a finished save to the overlay and leaves", async () => {
		const { exports, onExit, onSaveSettled } = mount()

		trimAFrame()

		const popover = await openSave()

		fireEvent.click(await within(popover).findByRole("button", { name: "Save as copy" }))

		await act(async () => {
			exports[0]?.settle({ status: "done", item: COPY })
			await Promise.resolve()
		})

		expect(onSaveSettled).toHaveBeenCalledWith(COPY, "copy")
		expect(onExit).toHaveBeenCalledTimes(1)
		expect(toast.success).toHaveBeenCalledWith("Saved a copy of clip.mp4")
	})

	it("cancels an export and retries a failed one with the same edits", async () => {
		const { exports, client } = mount()

		trimAFrame()

		const popover = await openSave()

		fireEvent.click(await within(popover).findByRole("button", { name: "Save" }))
		fireEvent.click(screen.getByRole("button", { name: "Cancel export" }))

		await waitFor(() => {
			expect(screen.queryByText(/Exporting…/)).toBeNull()
		})
		expect(exports[0]?.cancel).toHaveBeenCalledTimes(1)

		fireEvent.click(await within(await openSave()).findByRole("button", { name: "Save" }))

		await act(async () => {
			exports[1]?.settle({ status: "error", message: "network gone" })
			await Promise.resolve()
		})

		expect(screen.getByText("The video couldn't be saved.")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Retry" }))

		expect(client.exportVideo).toHaveBeenCalledTimes(3)
		expect(exports[2]?.recipe).toBe(exports[1]?.recipe)
		expect(exports[2]?.target).toBe("inPlace")
	})

	it("cannot save offline", async () => {
		state.online = false
		mount()

		trimAFrame()

		const popover = await openSave()
		const save = await within(popover).findByRole("button", { name: "Save" })

		expect(save).toHaveProperty("disabled", true)
		expect(within(popover).getByText(/offline/i)).toBeTruthy()
	})

	it("opens the Save popover for the overlay's Mod+S once there is something to save", async () => {
		const { commandsRef } = mount()

		act(() => {
			commandsRef.current?.openSave()
		})
		expect(screen.queryByRole("dialog")).toBeNull()

		trimAFrame()
		act(() => {
			commandsRef.current?.openSave()
		})

		expect(await screen.findByRole("dialog")).toBeTruthy()
	})

	it("removes a selected section and restores it from the Trim tab", async () => {
		const { root, plans } = mount()

		await waitFor(() => {
			expect(plans.length).toBeGreaterThan(0)
		})

		const video = document.querySelector("video")

		if (video === null) {
			throw new Error("no video")
		}

		video.currentTime = 10
		fireEvent.keyDown(root, { key: "i", code: "KeyI" })
		video.currentTime = 20
		fireEvent.keyDown(root, { key: "o", code: "KeyO" })
		fireEvent.keyDown(root, { key: "Delete", code: "Delete" })

		await waitFor(() => {
			expect(lastPlanned(plans).keep).toEqual([
				{ start: 0, end: 10 },
				{ start: 20, end: 100 }
			])
		})

		fireEvent.click(screen.getByRole("button", { name: "Restore 00:10.00 to 00:20.00" }))

		await waitFor(() => {
			expect(lastPlanned(plans).keep).toEqual([{ start: 0, end: 100 }])
		})
	})
})
