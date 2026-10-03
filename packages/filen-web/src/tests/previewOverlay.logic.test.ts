import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { startDownloadsMock } = vi.hoisted(() => ({ startDownloadsMock: vi.fn() }))

vi.mock("@/features/drive/lib/download", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/drive/lib/download")>()
	return { ...actual, startDownloads: startDownloadsMock }
})

import {
	isTextEditingTarget,
	previewMenuHiddenActionIds,
	previewNavigationUnmountsOverlay,
	resolveUnsavedConfirm,
	unsavedPromptOpen
} from "@/features/preview/components/previewOverlay.logic"
import { PHOTOS_HIDDEN_ACTION_IDS } from "@/features/photos/lib/itemActions"
import { driveItemActions, type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import type { DriveVariant } from "@/features/drive/lib/preferences"

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

	it("queries CodeMirror, text fields and marked surfaces", () => {
		let queried: string | undefined
		const target = {
			closest: (selector: string) => {
				queried = selector
				return {}
			}
		} as unknown as EventTarget

		isTextEditingTarget(target)

		expect(queried).toBe(".cm-editor, input, textarea, [data-preview-surface]")
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

// The header menu is the row/tile dropdown's driveItemActions minus previewMenuHiddenActionIds.
function menuIds(item: DriveItem, variant: DriveVariant, extraHidden?: ReadonlySet<ItemActionId>): string[] {
	const hidden = previewMenuHiddenActionIds(extraHidden)

	return driveItemActions(item, variant)
		.map(descriptor => descriptor.id)
		.filter(id => !hidden.has(id))
}

describe("previewMenuHiddenActionIds (preview header item-menu derivation)", () => {
	it("drops download from the drive-variant set — the header already has its own download button", () => {
		expect(menuIds(fileItem(), "drive")).not.toContain("download")
		expect(menuIds(fileItem(), "drive")).toEqual([
			"rename",
			"move",
			"copy",
			"compress",
			"favorite",
			"versions",
			"info",
			"share",
			"publicLink",
			"trash"
		])
	})

	it("opened from Photos, drops Move like the Photos grid and keeps Compress (the header keeps its own download)", () => {
		expect(menuIds(fileItem(), "drive", PHOTOS_HIDDEN_ACTION_IDS)).toEqual([
			"rename",
			"copy",
			"compress",
			"favorite",
			"versions",
			"info",
			"share",
			"publicLink",
			"trash"
		])
	})

	it("otherwise matches driveItemActions' own variant gating exactly (download aside)", () => {
		expect(menuIds(dirItem(), "trash")).toEqual(["restore", "deletePermanently", "info"])
		expect(menuIds(fileItem(), "links")).toEqual([
			"rename",
			"copy",
			"compress",
			"favorite",
			"versions",
			"info",
			"share",
			"publicLink",
			"copyLink",
			"trash"
		])
		expect(menuIds(fileItem(), "sharedIn")).toEqual(["info", "copy", "compress"])
	})

	it("download is the only id ever stripped — every other descriptor (including a second read-only one) survives", () => {
		const withDownload = [
			"rename",
			"move",
			"copy",
			"compress",
			"favorite",
			"versions",
			"info",
			"download",
			"share",
			"publicLink",
			"trash"
		]
		expect(menuIds(fileItem(), "drive")).toEqual(withDownload.filter(id => id !== "download"))
	})
})

describe("previewNavigationUnmountsOverlay", () => {
	it("is false for a same-route change (a deeper /drive/$ splat keeps the overlay mounted)", () => {
		expect(previewNavigationUnmountsOverlay("/_app/drive/$", "/_app/drive/$")).toBe(false)
	})

	it("is true when the navigation lands on a different route file", () => {
		expect(previewNavigationUnmountsOverlay("/_app/drive/$", "/_app/favorites")).toBe(true)
	})
})

describe("unsavedPromptOpen", () => {
	it("is false when nothing is pending, nothing is blocked and no sign-out waits", () => {
		expect(unsavedPromptOpen(null, false, false)).toBe(false)
	})

	it("is true for a pending in-app intent alone", () => {
		expect(unsavedPromptOpen("close", false, false)).toBe(true)
	})

	it("is true for a blocked navigation alone", () => {
		expect(unsavedPromptOpen(null, true, false)).toBe(true)
	})

	it("is true for a waiting sign-out alone", () => {
		expect(unsavedPromptOpen(null, false, true)).toBe(true)
	})
})

describe("resolveUnsavedConfirm", () => {
	it("releases the navigation and drops the queued intent when both are live", () => {
		expect(resolveUnsavedConfirm("next", true, false)).toEqual({ proceedNavigation: true, proceedLogout: false, intent: null })
	})

	it("releases BOTH external waiters when a blocked navigation and a waiting sign-out are live at once", () => {
		expect(resolveUnsavedConfirm("close", true, true)).toEqual({ proceedNavigation: true, proceedLogout: true, intent: null })
	})

	it("returns the intent for each of close/prev/next when no external waiter is live", () => {
		expect(resolveUnsavedConfirm("close", false, false).intent).toBe("close")
		expect(resolveUnsavedConfirm("prev", false, false).intent).toBe("prev")
		expect(resolveUnsavedConfirm("next", false, false).intent).toBe("next")
	})

	it("returns all-false/null when nothing is live", () => {
		expect(resolveUnsavedConfirm(null, false, false)).toEqual({ proceedNavigation: false, proceedLogout: false, intent: null })
	})
})
