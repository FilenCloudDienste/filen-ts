import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// previewOverlay.logic.ts's previewMenuActions pulls in itemMenu.logic.ts, which imports
// features/drive/lib/download.ts (startDownloads) — unresolvable/unwanted under node vitest, same
// mocking boundary as itemMenu.test.ts.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { startDownloadsMock } = vi.hoisted(() => ({ startDownloadsMock: vi.fn() }))

vi.mock("@/features/drive/lib/download", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/download")>()
	return { ...actual, startDownloads: startDownloadsMock }
})

import { isTextEditingTarget, previewMenuActions, previewMenuVisible } from "@/features/preview/components/previewOverlay.logic"

// Minimal duck-typed stand-in for a DOM EventTarget — no jsdom/happy-dom in this project
// (vitest.config.ts: environment "node"), mirroring lib/auth/referral.test.ts's own stubbed `document`
// idiom for the same reason.
function fakeTarget(closestResult: object | null): EventTarget {
	return { closest: (_selector: string) => closestResult } as unknown as EventTarget
}

describe("isTextEditingTarget", () => {
	it("is false for a null target", () => {
		expect(isTextEditingTarget(null)).toBe(false)
	})

	it("is false for a target with no closest method at all (not element-shaped)", () => {
		expect(isTextEditingTarget({} as unknown as EventTarget)).toBe(false)
	})

	it("is false when closest finds no enclosing .cm-editor", () => {
		expect(isTextEditingTarget(fakeTarget(null))).toBe(false)
	})

	it("is true once closest resolves a .cm-editor ancestor — editable or read-only alike", () => {
		expect(isTextEditingTarget(fakeTarget({}))).toBe(true)
	})

	it("queries exactly .cm-editor, not a broader or unrelated selector", () => {
		let queried: string | undefined
		const target = {
			closest: (selector: string) => {
				queried = selector
				return {}
			}
		} as unknown as EventTarget

		isTextEditingTarget(target)

		expect(queried).toBe(".cm-editor")
	})
})

// Local fixtures mirror itemMenu.test.ts's own per-file convention (each test file owns its minimal
// Dir/File shape rather than sharing one across files).
function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
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
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

function dirItem(overrides: Partial<Dir> = {}): DriveItem {
	return narrowItem(mockDir(overrides))
}

function fileItem(overrides: Partial<File> = {}): DriveItem {
	return narrowItem(mockFile(overrides))
}

function menuIds(item: DriveItem, variant: Parameters<typeof previewMenuActions>[1]): string[] {
	return previewMenuActions(item, variant).map(descriptor => descriptor.id)
}

describe("previewMenuActions (preview header item-menu derivation)", () => {
	it("drops download from the drive-variant set — the header already has its own download button", () => {
		expect(menuIds(fileItem(), "drive")).not.toContain("download")
		expect(menuIds(fileItem(), "drive")).toEqual([
			"rename",
			"move",
			"favorite",
			"versions",
			"info",
			"share",
			"publicLink",
			"copyLink",
			"trash"
		])
	})

	it("otherwise matches driveItemActions' own variant gating exactly (download aside)", () => {
		expect(menuIds(dirItem(), "trash")).toEqual(["restore", "deletePermanently", "info"])
		expect(menuIds(fileItem(), "links")).toEqual(["rename", "favorite", "versions", "info", "publicLink", "copyLink", "trash"])
		expect(menuIds(fileItem(), "sharedIn")).toEqual(["info", "import"])
	})

	it("download is the only id ever stripped — every other descriptor (including a second read-only one) survives", () => {
		const withDownload = ["rename", "move", "favorite", "versions", "info", "download", "share", "publicLink", "copyLink", "trash"]
		expect(menuIds(fileItem(), "drive")).toEqual(withDownload.filter(id => id !== "download"))
	})
})

describe("previewMenuVisible (drive-sourced items only)", () => {
	it("is true for the drive arm", () => {
		expect(previewMenuVisible({ type: "drive", item: fileItem() })).toBe(true)
	})

	it("is false for the external arm — no DriveItem for driveItemActions to gate against", () => {
		expect(previewMenuVisible({ type: "external", url: "https://example.com/a.png", name: "a.png" })).toBe(false)
	})
})
