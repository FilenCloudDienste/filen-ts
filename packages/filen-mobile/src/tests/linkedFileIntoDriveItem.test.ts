import { vi, describe, it, expect } from "vitest"

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/lib/cache", () => ({
	default: {
		rootUuid: null,
		directoryUuidToAnyNormalDir: new Map(),
		directoryUuidToAnySharedDirWithContext: new Map(),
		fileUuidToNormalFile: new Map()
	}
}))

// Only what sdkUnwrap.ts touches on the linked-file path: FileMeta.Decoded / ParentUuid.Uuid as
// tag+inner classes (the generated bindings' shape), the two tag enums it switches on, and inert
// stand-ins for the value imports it never reaches here.
vi.mock("@filen/sdk-rs", () => {
	class TaggedUnion {
		tag: string
		inner: unknown[]

		constructor(tag: string, value: unknown) {
			this.tag = tag
			this.inner = [value]
		}
	}

	return {
		FileMeta: {
			Decoded: class extends TaggedUnion {
				constructor(meta: unknown) {
					super("Decoded", meta)
				}
			}
		},
		FileMeta_Tags: { Decoded: "Decoded", DecryptedRaw: "DecryptedRaw", Encrypted: "Encrypted", RsaEncrypted: "RsaEncrypted" },
		DirMeta_Tags: { Decoded: "Decoded" },
		ParentUuid: {
			Uuid: class extends TaggedUnion {
				constructor(uuid: string) {
					super("Uuid", uuid)
				}
			}
		},
		ParentUuid_Tags: { Uuid: "Uuid", Trash: "Trash", Recents: "Recents", Favorites: "Favorites", Links: "Links" },
		SharingRole: {},
		AnyDirWithContext: {},
		AnyDirWithContext_Tags: {},
		AnyNormalDir_Tags: {},
		AnySharedDir_Tags: {},
		AnyNormalDir: {},
		AnySharedDir: {},
		AnyFile: { instanceOf: () => false },
		AnyFile_Tags: { File: "File", Shared: "Shared", Linked: "Linked" },
		AnyLinkedDir_Tags: {},
		MaybeEncryptedUniffi_Tags: { Decrypted: "Decrypted", Encrypted: "Encrypted" }
	}
})

import { linkedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { type DriveItemFile, type DriveItemFileExtracted } from "@/types"

function makeLinkedFile(canMakeThumbnail: boolean) {
	return {
		uuid: "linked-uuid",
		name: { tag: "Decrypted", inner: ["shot.cr2"] },
		mime: { tag: "Decrypted", inner: ["image/x-canon-cr2"] },
		size: 24_000_000n,
		chunks: 23n,
		region: "de-1",
		bucket: "b",
		version: 2,
		timestamp: 1700000000n,
		fileKey: "file-key",
		linkedTag: true,
		canMakeThumbnail
	} as never
}

describe("linkedFileIntoDriveItem", () => {
	it("carries the SDK's canMakeThumbnail through instead of a hardcoded false", () => {
		const yes = linkedFileIntoDriveItem(makeLinkedFile(true)) as DriveItemFileExtracted
		const no = linkedFileIntoDriveItem(makeLinkedFile(false)) as DriveItemFileExtracted

		expect(yes.type).toBe("file")
		expect(yes.data.canMakeThumbnail).toBe(true)
		expect(no.data.canMakeThumbnail).toBe(false)
	})

	it("keeps the rest of the public-link shim: no stable id, a parent the pipeline never reads, decrypted meta", () => {
		const item = linkedFileIntoDriveItem(makeLinkedFile(true)) as DriveItemFileExtracted

		expect((item.data as DriveItemFile).stableUuid).toBeUndefined()
		expect((item.data as unknown as { parent: { tag: string; inner: unknown[] } }).parent).toMatchObject({
			tag: "Uuid",
			inner: ["linked-uuid"]
		})
		expect(item.data.decryptedMeta?.name).toBe("shot.cr2")
		expect(item.data.uuid).toBe("linked-uuid")
	})
})
