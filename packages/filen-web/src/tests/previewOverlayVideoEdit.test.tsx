// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File as SdkFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import type { VideoEditorProps } from "@/features/preview/videoEdit/components/videoEditor"
import { FAKE_INFO } from "@/tests/support/fakeVideoEditClient"

// The video editor inside the preview overlay: Edit video opens it with the overlay's header gone, a source with no
// picture this browser shows is refused (and Edit is not offered again), an in-place save shows the new version, a copy
// is noted beside the file, Cancel over unsaved edits asks first, and Escape never leaves while an export runs.

const mocks = vi.hoisted(() => ({
	useAction: vi.fn<(id: string, handler: () => void, options?: unknown) => void>()
}))
const harness = vi.hoisted(() => ({
	props: null as VideoEditorProps | null,
	previewable: true,
	disposed: 0,
	exporting: false,
	openSave: vi.fn(),
	toastError: vi.fn(),
	splices: [] as unknown[],
	// Files (stable uuid, else uuid) with a save of an edit running.
	running: new Set<string>(),
	runningListeners: new Set<() => void>()
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: harness.toastError, warning: vi.fn(), info: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: mocks.useAction, IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/drive/lib/actions", async () => ({
	...(await vi.importActual<typeof import("@/features/drive/lib/actions")>("@/features/drive/lib/actions")),
	currentRootUuid: () => "00000000-0000-0000-0000-0000000000aa"
}))
vi.mock("@/features/photos/queries/photos", () => ({
	splicePhotoSave: (...args: unknown[]) => {
		harness.splices.push(args)
	}
}))
vi.mock("@/features/preview/components/mediaViewer", () => ({ MediaViewer: () => createElement("div", { "data-testid": "player" }) }))
vi.mock("@/features/preview/videoEdit/client", () => ({
	createVideoEditClient: () => ({
		loadSource: () => Promise.resolve({ ...FAKE_INFO, previewable: harness.previewable }),
		dispose: () => {
			harness.disposed++
		}
	})
}))
vi.mock("@/features/preview/videoEdit/save", async () => ({
	...(await vi.importActual<typeof import("@/features/preview/videoEdit/save")>("@/features/preview/videoEdit/save")),
	isVideoExportRunning: (file: string) => harness.running.has(file),
	subscribeVideoExports: (listener: () => void) => {
		harness.runningListeners.add(listener)

		return () => {
			harness.runningListeners.delete(listener)
		}
	}
}))
vi.mock("@/features/preview/videoEdit/components/videoEditor", () => ({
	VideoEditor: (props: VideoEditorProps) => {
		const { commandsRef, onDirtyChange } = props

		harness.props = props

		useEffect(() => {
			commandsRef.current = { openSave: harness.openSave, saveCopy: vi.fn(), exporting: () => harness.exporting }
			onDirtyChange(true)
		}, [commandsRef, onDirtyChange])

		return createElement("div", { "data-testid": "video-editor" }, props.title)
	}
}))

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { narrowItem } from "@/features/drive/lib/item"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { withCode } from "@/tests/support/keys"

registerAllActions()

const UUID: SdkFile["uuid"] = "11111111-1111-1111-1111-111111111111"
const RUNNING = "This video is still being saved. Edit it again once that save finishes."

function video(uuid: SdkFile["uuid"] = UUID, name = "clip.mp4"): DriveItem {
	const file: SdkFile = {
		uuid,
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: {
				name,
				mime: "video/mp4",
				created: 1_500_000_000_000n,
				modified: 1_700_000_000_000n,
				size: 1_024n,
				key: "key",
				version: 2
			}
		}
	}

	return narrowItem(file)
}

function props(): VideoEditorProps {
	if (harness.props === null) {
		throw new Error("the editor never opened")
	}

	return harness.props
}

async function openEditor(): Promise<void> {
	render(
		createElement(PreviewOverlay, {
			variant: "drive" as const,
			items: [video()],
			index: 0,
			onStep: vi.fn(),
			onClose: vi.fn(),
			onItemRemoved: vi.fn()
		})
	)

	fireEvent.click(await screen.findByRole("button", { name: "Edit video" }))
	await screen.findByTestId("video-editor")
	await waitFor(() => {
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(true)
	})
}

beforeEach(() => {
	harness.props = null
	harness.previewable = true
	harness.disposed = 0
	harness.exporting = false
	harness.splices = []
	harness.running.clear()
	harness.runningListeners.clear()
	mocks.useAction.mockClear()
	harness.openSave.mockClear()
	harness.toastError.mockClear()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

afterEach(() => {
	cleanup()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("PreviewOverlay — video editing", () => {
	it("opens the editor in place of the viewer, with its own header and the dialog's title", async () => {
		await openEditor()

		expect(screen.queryByTestId("player")).toBeNull()
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
		expect(screen.getByRole("dialog").className).toContain("dark")
		expect(screen.getByRole("heading").textContent).toContain("clip")
	})

	it("refuses a video with no picture this browser shows, and offers no Edit for it again", async () => {
		harness.previewable = false

		render(
			createElement(PreviewOverlay, {
				variant: "drive" as const,
				items: [video("44444444-4444-4444-4444-444444444444")],
				index: 0,
				onStep: vi.fn(),
				onClose: vi.fn(),
				onItemRemoved: vi.fn()
			})
		)

		fireEvent.click(await screen.findByRole("button", { name: "Edit video" }))

		await waitFor(() => {
			expect(harness.toastError).toHaveBeenCalledWith("This video can't be edited in this browser.")
		})
		expect(screen.queryByTestId("video-editor")).toBeNull()
		expect(harness.disposed).toBe(1)
	})

	it("disables Edit video while a save of the same video runs, saying why, and enables it once that save ends", async () => {
		harness.running.add(UUID)

		render(
			createElement(PreviewOverlay, {
				variant: "drive" as const,
				items: [video()],
				index: 0,
				onStep: vi.fn(),
				onClose: vi.fn(),
				onItemRemoved: vi.fn()
			})
		)

		const edit = await screen.findByRole("button", { name: "Edit video" })

		expect(edit.hasAttribute("disabled")).toBe(true)
		expect(edit.getAttribute("title")).toBe(RUNNING)

		act(() => {
			harness.running.delete(UUID)

			for (const listener of harness.runningListeners) {
				listener()
			}
		})

		expect(edit.hasAttribute("disabled")).toBe(false)
		expect(edit.getAttribute("title")).toBeNull()
	})

	it("refuses the Edit video key while a save of the same video runs, saying why", async () => {
		harness.running.add(UUID)

		render(
			createElement(PreviewOverlay, {
				variant: "drive" as const,
				items: [video()],
				index: 0,
				onStep: vi.fn(),
				onClose: vi.fn(),
				onItemRemoved: vi.fn()
			})
		)

		await screen.findByRole("button", { name: "Edit video" })

		const handler = mocks.useAction.mock.calls.findLast(([id]) => id === "preview.editVideo")?.[1]

		expect(handler).toBeTypeOf("function")

		act(() => {
			handler?.()
		})

		expect(harness.toastError).toHaveBeenCalledWith(RUNNING)
		expect(screen.queryByTestId("video-editor")).toBeNull()
		expect(harness.disposed).toBe(0)
	})

	it("shows the new version once an in-place save lands, and leaves edit mode", async () => {
		await openEditor()

		const settled = props().onSaveStarted("inPlace")
		const saved = video("33333333-3333-3333-3333-333333333333")

		act(() => {
			settled(saved)
			props().onDirtyChange(false)
			props().onExit()
		})

		await waitFor(() => {
			expect(screen.queryByTestId("video-editor")).toBeNull()
		})
		expect(harness.splices).toEqual([[UUID, saved, "replace"]])
		expect(harness.disposed).toBe(1)
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(false)
	})

	it("notes a copy beside the file without showing it in the slot", async () => {
		await openEditor()

		const settled = props().onSaveStarted("copy")
		const copy = video("55555555-5555-5555-5555-555555555555", "clip (edited).mp4")

		act(() => {
			settled(copy)
		})

		expect(harness.splices).toEqual([[UUID, copy, "beside"]])
		expect(screen.getByTestId("video-editor")).toBeDefined()
	})

	it("asks before Cancel drops unsaved edits, and leaves edit mode on Discard", async () => {
		await openEditor()

		act(() => {
			props().onCancel()
		})

		expect(await screen.findByRole("alertdialog")).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "Discard" }))

		await waitFor(() => {
			expect(screen.queryByTestId("video-editor")).toBeNull()
		})
		expect(harness.disposed).toBe(1)
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(false)
	})

	it("never leaves by Escape while an export runs in the editor", async () => {
		await openEditor()

		harness.exporting = true
		fireEvent.keyDown(screen.getByTestId("video-editor"), withCode({ key: "Escape" }))

		await act(async () => {
			await Promise.resolve()
		})

		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(screen.getByTestId("video-editor")).toBeDefined()

		harness.exporting = false
		fireEvent.keyDown(screen.getByTestId("video-editor"), withCode({ key: "Escape" }))

		expect(await screen.findByRole("alertdialog")).toBeDefined()
	})

	it("offers no Edit for a video outside the drive", async () => {
		render(
			createElement(PreviewOverlay, {
				variant: "sharedIn" as const,
				items: [video()],
				index: 0,
				onStep: vi.fn(),
				onClose: vi.fn(),
				onItemRemoved: vi.fn()
			})
		)

		await act(async () => {
			await Promise.resolve()
		})

		expect(screen.queryByRole("button", { name: "Edit video" })).toBeNull()
	})
})
