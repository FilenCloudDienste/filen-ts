// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File as SdkFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import type { SaveTarget } from "@/features/preview/imageEdit/types"

// The image editor inside the preview overlay: Edit opens it, a save writes a new version (keeping the original's
// creation time) and leaves edit mode, a copy is written beside the file without touching the slot, and Cancel over
// unsaved edits asks first.

const harness = vi.hoisted(() => ({
	saves: [] as { content: unknown; asNewFile?: string; mime?: string; times?: { created?: bigint; modified?: bigint } }[],
	exports: [] as unknown[],
	released: 0,
	targets: null as null | { primary: unknown; copy: unknown },
	toastSuccess: vi.fn(),
	splices: [] as unknown[]
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: harness.toastSuccess, error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
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
vi.mock("@/features/preview/components/imageViewer", () => ({ ImageViewer: () => null, RawImageViewer: () => null }))
vi.mock("@/features/drive/lib/previewSave.logic", async () => {
	const actual = await vi.importActual<typeof import("@/features/drive/lib/previewSave.logic")>("@/features/drive/lib/previewSave.logic")

	return {
		...actual,
		runPreviewSave: (
			_deps: unknown,
			args: {
				item: DriveItem
				content: unknown
				asNewFile?: string
				mime?: string
				times?: { created?: bigint; modified?: bigint }
			}
		) => {
			harness.saves.push(args)

			return Promise.resolve({
				status: "success",
				item: { ...args.item, data: { ...args.item.data, uuid: "33333333-3333-3333-3333-333333333333" } }
			})
		}
	}
})
vi.mock("@/features/preview/imageEdit/editSession", () => ({
	takenNames: () => Promise.resolve(new Set(["photo (edited).jpg"])),
	enterImageEdit: ({ item, frozenUuid }: { item: DriveItem; frozenUuid: string }) =>
		Promise.resolve({
			status: "ready",
			state: {
				frozenUuid,
				uuid: item.data.uuid,
				source: { kind: "blob", blob: new Blob([]) },
				info: { mime: "image/jpeg", width: 4, height: 3, hasAlpha: false },
				session: { close: vi.fn() },
				capabilities: { webgl2: true, maxTextureSize: 4096, maxPixels: 1e8, canEncodeWebp: true },
				targets: harness.targets,
				buffered: false,
				release: () => {
					harness.released++
				}
			}
		})
}))
vi.mock("@/features/preview/imageEdit/components/imageEditor", () => ({
	ImageEditor: ({
		saveRef,
		commandsRef,
		onDirtyChange
	}: {
		saveRef: { current: unknown }
		commandsRef: { current: unknown }
		onDirtyChange: (dirty: boolean) => void
	}) => {
		useEffect(() => {
			saveRef.current = (target: SaveTarget) => {
				harness.exports.push(target)

				return Promise.resolve({ blob: new Blob([new Uint8Array([1])], { type: target.mime }), geometryOnly: null })
			}
			commandsRef.current = { undo: vi.fn(), redo: vi.fn(), revert: vi.fn() }
			onDirtyChange(true)
		}, [saveRef, commandsRef, onDirtyChange])

		return createElement("div", { "data-testid": "image-editor" })
	}
}))

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { narrowItem } from "@/features/drive/lib/item"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

registerAllActions()

const CREATED = 1_500_000_000_000n

function image(name: string, mime: string): DriveItem {
	const file: SdkFile = {
		uuid: "11111111-1111-1111-1111-111111111111",
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
			data: { name, mime, created: CREATED, modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	}

	return narrowItem(file)
}

async function openEditor(name: string, mime: string): Promise<void> {
	render(
		createElement(PreviewOverlay, {
			variant: "drive" as const,
			items: [image(name, mime)],
			index: 0,
			onStep: vi.fn(),
			onClose: vi.fn(),
			onItemRemoved: vi.fn()
		})
	)

	fireEvent.click(await screen.findByRole("button", { name: "Edit" }))
	await screen.findByTestId("image-editor")
	await waitFor(() => {
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(true)
	})
}

beforeEach(() => {
	harness.saves = []
	harness.exports = []
	harness.released = 0
	harness.splices = []
	harness.toastSuccess.mockClear()
	harness.targets = { primary: { kind: "inPlace", mime: "image/jpeg" }, copy: { kind: "copy", mime: "image/jpeg", extension: "jpg" } }
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

afterEach(() => {
	cleanup()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("PreviewOverlay — image editing", () => {
	it("saves a new version with the original's creation time, then leaves edit mode", async () => {
		await openEditor("photo.jpg", "image/jpeg")

		fireEvent.click(screen.getByRole("button", { name: "Save" }))

		await waitFor(() => {
			expect(screen.queryByTestId("image-editor")).toBeNull()
		})
		expect(harness.exports).toEqual([{ kind: "inPlace", mime: "image/jpeg" }])
		expect(harness.saves).toHaveLength(1)
		expect(harness.saves[0]?.asNewFile).toBeUndefined()
		const content = harness.saves[0]?.content

		expect(typeof content === "object" && content !== null && "blob" in content && content.blob instanceof Blob).toBe(true)
		expect(harness.saves[0]?.times?.created).toBe(CREATED)
		expect(harness.saves[0]?.mime).toBe("image/jpeg")
		expect(harness.splices).toEqual([["11111111-1111-1111-1111-111111111111", expect.anything(), "replace"]])
		expect(harness.released).toBe(1)
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(false)
	})

	it("writes a copy-only format's edit as a copy beside it, the slot left on the original", async () => {
		harness.targets = {
			primary: { kind: "copy", mime: "image/jpeg", extension: "jpg" },
			copy: { kind: "copy", mime: "image/jpeg", extension: "jpg" }
		}

		await openEditor("photo.heic", "image/heic")

		fireEvent.click(screen.getByRole("button", { name: "Save as JPEG copy" }))

		await waitFor(() => {
			expect(harness.toastSuccess).toHaveBeenCalled()
		})
		expect(harness.saves).toHaveLength(1)
		expect(harness.saves[0]?.asNewFile).toBe("photo (edited 2).jpg")
		expect(harness.saves[0]?.mime).toBe("")
		expect(harness.saves[0]?.times?.created).toBe(CREATED)
		expect(harness.toastSuccess.mock.calls[0]?.[0]).toBe("Saved as photo (edited 2).jpg")
		expect(harness.splices).toEqual([["11111111-1111-1111-1111-111111111111", expect.anything(), "beside"]])
		// Never shown in the slot: the title still names the original.
		expect(screen.queryByTestId("image-editor")).toBeNull()
		expect(screen.getAllByText(/photo/).some(element => element.textContent.includes("heic"))).toBe(true)
	})

	it("asks before Cancel drops unsaved edits, and leaves edit mode on Discard without saving", async () => {
		await openEditor("photo.jpg", "image/jpeg")

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		const prompt = await screen.findByRole("alertdialog")

		expect(prompt).toBeDefined()
		expect(screen.getByTestId("image-editor")).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "Discard" }))

		await waitFor(() => {
			expect(screen.queryByTestId("image-editor")).toBeNull()
		})
		expect(harness.saves).toHaveLength(0)
		expect(harness.released).toBe(1)
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(false)
	})

	it("offers no Edit for an image outside the drive", async () => {
		render(
			createElement(PreviewOverlay, {
				variant: "sharedIn" as const,
				items: [image("photo.jpg", "image/jpeg")],
				index: 0,
				onStep: vi.fn(),
				onClose: vi.fn(),
				onItemRemoved: vi.fn()
			})
		)

		await act(async () => {
			await Promise.resolve()
		})

		expect(screen.queryByRole("button", { name: "Edit" })).toBeNull()
	})
})
