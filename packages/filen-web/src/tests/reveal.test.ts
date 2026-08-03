import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, GetItemPathResult, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — reveal.ts
// pulls it in transitively through queries/drive. Every case below injects its own fetchPath, so no
// worker op is ever reached.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError, info: vi.fn() } }))

import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { resolveContainingDirectoryTarget, runOpenContainingDirectory, type RevealDeps } from "@/features/drive/lib/reveal"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function ancestor(uuid: string): Dir {
	return {
		uuid,
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: uuid } }
	} as Dir
}

function hitItem(): DriveItem {
	const file: File = {
		uuid: testUuid("hit"),
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "notes.txt", mime: "text/plain", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	}

	return narrowItem(file)
}

function deps(fetchPath: RevealDeps["fetchPath"]): RevealDeps {
	return { fetchPath }
}

function pathResult(ancestorUuids: string[]): GetItemPathResult {
	return { path: ancestorUuids.join("/"), ancestors: ancestorUuids.map(ancestor) }
}

beforeEach(() => {
	vi.clearAllMocks()
	useDriveStore.setState({ selectedItems: [], pendingReveal: null })
})

describe("resolveContainingDirectoryTarget", () => {
	it("builds the FULL ancestor splat, not a one-segment parent uuid", async () => {
		const outcome = await resolveContainingDirectoryTarget(
			deps(() => Promise.resolve(pathResult(["a", "b", "c"]))),
			hitItem()
		)

		expect(outcome).toEqual({ status: "success", target: { to: "/drive/$", params: { _splat: "a/b/c" } } })
	})

	it("a rejected path walk returns an error outcome, not a root target", async () => {
		const outcome = await resolveContainingDirectoryTarget(
			deps(() => Promise.reject(new Error("walk failed"))),
			hitItem()
		)

		expect(outcome.status).toBe("error")
		expect(outcome).not.toHaveProperty("target")
	})

	it("carries the rejection through as an ErrorDTO errorLabel can render", async () => {
		const outcome = await resolveContainingDirectoryTarget(
			deps(() => Promise.reject(new Error("walk failed"))),
			hitItem()
		)

		expect(outcome.status === "error" && outcome.dto.label).toBe("walk failed")
	})

	it("a successful walk with an EMPTY ancestor chain resolves the root splat", async () => {
		const outcome = await resolveContainingDirectoryTarget(
			deps(() => Promise.resolve(pathResult([]))),
			hitItem()
		)

		expect(outcome).toEqual({ status: "success", target: { to: "/drive/$", params: { _splat: "" } } })
	})

	it("asks for the path by the item's own uuid", async () => {
		const fetchPath = vi.fn(() => Promise.resolve(pathResult(["a"])))
		const item = hitItem()

		await resolveContainingDirectoryTarget(deps(fetchPath), item)

		expect(fetchPath).toHaveBeenCalledExactlyOnceWith(item)
	})
})

describe("runOpenContainingDirectory", () => {
	it("arms the reveal for the destination splat and navigates there", async () => {
		const navigate = vi.fn()
		const item = hitItem()

		await runOpenContainingDirectory(
			deps(() => Promise.resolve(pathResult(["a", "b"]))),
			item,
			navigate
		)

		expect(useDriveStore.getState().pendingReveal).toEqual({ uuid: item.data.uuid, splat: "a/b" })
		expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: "/drive/$", params: { _splat: "a/b" } })
		expect(toastError).not.toHaveBeenCalled()
	})

	it("a failed walk toasts, arms NO reveal and never navigates", async () => {
		const navigate = vi.fn()

		await runOpenContainingDirectory(
			deps(() => Promise.reject(new Error("walk failed"))),
			hitItem(),
			navigate
		)

		expect(useDriveStore.getState().pendingReveal).toBeNull()
		expect(navigate).not.toHaveBeenCalled()
		expect(toastError).toHaveBeenCalledExactlyOnceWith("walk failed")
	})
})
