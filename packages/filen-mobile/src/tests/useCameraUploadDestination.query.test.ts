import { vi, describe, it, expect, beforeEach } from "vitest"

// Pure fetchData test — no React. Mock the heavy infra modules the query file pulls in at
// module load (the real @/queries/client drags in sqlite/alerts/etc) and the SDK + sdkUnwrap.

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {}
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir_Tags: { Dir: "Dir", Root: "Root" }
}))

vi.mock("@/lib/auth", () => ({
	default: { getSdkClients: vi.fn() }
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	isTrashParent: (parent: { tag?: string } | null | undefined) => parent?.tag === "Trash",
	unwrapDirMeta: (dir: { meta?: { tag?: string; inner?: { name?: string }[] } }) => ({
		meta: dir?.meta?.tag === "Decoded" ? (dir.meta.inner?.[0] ?? null) : null
	})
}))

import { fetchData } from "@/features/cameraUpload/queries/useCameraUploadDestination.query"
import auth from "@/lib/auth"

function installGetDirOptional(impl: () => Promise<unknown>): ReturnType<typeof vi.fn> {
	const getDirOptional = vi.fn(impl)

	vi.mocked(auth.getSdkClients).mockResolvedValue({
		authedSdkClient: { getDirOptional }
	} as any)

	return getDirOptional
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("useCameraUploadDestination.query fetchData", () => {
	it("returns usable:true and the fresh decrypted name for a usable directory", async () => {
		installGetDirOptional(async () => ({
			uuid: "dir-uuid",
			parent: { tag: "Uuid", inner: ["root-uuid"] },
			meta: { tag: "Decoded", inner: [{ name: "Fresh Name" }] }
		}))

		const result = await fetchData({ uuid: "dir-uuid" })

		expect(result).toEqual({ usable: true, name: "Fresh Name" })
	})

	it("returns usable:false and name:null when the directory was deleted (undefined)", async () => {
		installGetDirOptional(async () => undefined)

		const result = await fetchData({ uuid: "dir-uuid" })

		expect(result).toEqual({ usable: false, name: null })
	})

	it("returns usable:false when the directory is trashed (still surfacing its fresh name)", async () => {
		installGetDirOptional(async () => ({
			uuid: "dir-uuid",
			parent: { tag: "Trash" },
			meta: { tag: "Decoded", inner: [{ name: "Trashed Name" }] }
		}))

		const result = await fetchData({ uuid: "dir-uuid" })

		expect(result).toEqual({ usable: false, name: "Trashed Name" })
	})

	it("returns name:null for an undecryptable directory meta", async () => {
		installGetDirOptional(async () => ({
			uuid: "dir-uuid",
			parent: { tag: "Uuid", inner: ["root-uuid"] },
			meta: { tag: "Encrypted" }
		}))

		const result = await fetchData({ uuid: "dir-uuid" })

		expect(result).toEqual({ usable: true, name: null })
	})

	it("passes the abort signal through to getDirOptional", async () => {
		const getDirOptional = installGetDirOptional(async () => undefined)
		const signal = new AbortController().signal

		await fetchData({ uuid: "dir-uuid", signal })

		expect(getDirOptional).toHaveBeenCalledWith("dir-uuid", { signal })
	})

	it("omits asyncOpts when no signal is provided", async () => {
		const getDirOptional = installGetDirOptional(async () => undefined)

		await fetchData({ uuid: "dir-uuid" })

		expect(getDirOptional).toHaveBeenCalledWith("dir-uuid", undefined)
	})
})
