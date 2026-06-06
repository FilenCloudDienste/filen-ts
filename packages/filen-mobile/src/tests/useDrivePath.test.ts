// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	navigationId: "/tabs/drive/some-uuid",
	searchParams: {} as Record<string, string>,
	cameraUploadConfig: {
		enabled: false,
		remoteDir: null as { inner: [{ uuid: string }] } | null
	}
}))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-router", () => ({
	useLocalSearchParams: () => mocks.searchParams,
	useNavigation: () => ({
		getId: () => mocks.navigationId
	})
}))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-secure-store", async () => await import("@/tests/mocks/expoSecureStore"))

vi.mock("react-native-mmkv", async () => await import("@/tests/mocks/reactNativeMMKV"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("react-native-quick-crypto", async () => await import("@/tests/mocks/reactNativeQuickCrypto"))

vi.mock("react-fast-compare", async () => await import("@/tests/mocks/reactFastCompare"))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path.trim().replace(/^file:\/+/, "/")
}))

vi.mock("@/lib/events", () => ({
	default: {
		subscribe: () => ({ remove: () => {} }),
		emit: () => {}
	}
}))

vi.mock("@/lib/cache", () => ({
	default: {
		secureStore: {
			get: () => undefined,
			set: () => {},
			delete: () => {},
			clear: () => {}
		}
	}
}))

vi.mock("@/features/cameraUpload/cameraUpload", () => ({
	useCameraUpload: () => ({
		config: mocks.cameraUploadConfig
	})
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook } from "@testing-library/react"
import useDrivePath from "@/hooks/useDrivePath"
import { serialize } from "@/lib/serializer"
import type { SelectOptions, Linked } from "@/hooks/useDrivePath"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

function setNav(id: string, params: Record<string, string> = {}) {
	mocks.navigationId = id
	mocks.searchParams = params
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	mocks.navigationId = "/tabs/drive/" + VALID_UUID
	mocks.searchParams = { uuid: VALID_UUID }
	mocks.cameraUploadConfig = { enabled: false, remoteDir: null }
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useDrivePath — navigationId → DrivePathType mapping", () => {
	it("'/tabs/drive' with valid UUID → type='drive', uuid=VALID_UUID", () => {
		setNav("/tabs/drive/" + VALID_UUID, { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("drive")
		expect(result.current.uuid).toBe(VALID_UUID)
	})

	it("'/tabs/drive' with empty uuid param → uuid=null", () => {
		setNav("/tabs/drive/", { uuid: "" })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("drive")
		expect(result.current.uuid).toBeNull()
	})

	it("'/tabs/drive' with non-UUID param → uuid=null", () => {
		setNav("/tabs/drive/not-a-uuid", { uuid: "not-a-uuid" })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("drive")
		expect(result.current.uuid).toBeNull()
	})

	it("'/offline' → type='offline'", () => {
		setNav("/offline/" + VALID_UUID, { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("offline")
	})

	it("'/sharedIn' → type='sharedIn'", () => {
		setNav("/sharedIn/" + VALID_UUID, { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("sharedIn")
	})

	it("'/sharedOut' → type='sharedOut'", () => {
		setNav("/sharedOut/" + VALID_UUID, { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("sharedOut")
	})

	it("'/links' → type='links'", () => {
		setNav("/links/" + VALID_UUID, { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("links")
	})

	it("'/favorites' → type='favorites'", () => {
		setNav("/favorites/" + VALID_UUID, { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("favorites")
	})

	it("'/trash' → type='trash', uuid=null (forced null regardless of param)", () => {
		setNav("/trash", { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("trash")
		expect(result.current.uuid).toBeNull()
	})

	it("'/recents' → type='recents', uuid=null", () => {
		setNav("/recents", { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("recents")
		expect(result.current.uuid).toBeNull()
	})

	it("unknown navigationId → type=null, uuid=null (fallthrough)", () => {
		setNav("/unknownRoute/abc", { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBeNull()
		expect(result.current.uuid).toBeNull()
	})

	it("'/tabs/drive' starts with '/tabs/drive' → drives the 'drive' branch, not photos/offline/etc", () => {
		// '/tabs/drive/abc' must NOT match photos, offline, etc.
		setNav("/tabs/drive/" + VALID_UUID, { uuid: VALID_UUID })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("drive")
	})

	it("'/driveSelect' with valid selectOptions → type='drive' with selectOptions", () => {
		const opts: SelectOptions = {
			type: "multiple",
			files: true,
			directories: false,
			intention: "move",
			items: [],
			id: "sel-1"
		}
		const serialized = serialize(opts)

		setNav("/driveSelect/" + VALID_UUID, { uuid: VALID_UUID, selectOptions: serialized })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("drive")
		expect(result.current.selectOptions).toBeDefined()
		expect(result.current.selectOptions!.id).toBe("sel-1")
		expect(result.current.selectOptions!.type).toBe("multiple")
	})

	it("'/linkedDir' with valid linked param → type='linked' with linked payload", () => {
		const linked: Linked = {
			uuid: VALID_UUID,
			key: "secret-key",
			rootName: "My Linked Dir"
		}
		const serialized = serialize(linked)

		setNav("/linkedDir/" + VALID_UUID, { uuid: VALID_UUID, linked: serialized })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.type).toBe("linked")
		expect(result.current.linked).toBeDefined()
		expect(result.current.linked!.uuid).toBe(VALID_UUID)
		expect(result.current.linked!.key).toBe("secret-key")
	})

	describe("photos screen", () => {
		it("cameraUpload enabled + remoteDir set → uuid = remoteDir.inner[0].uuid", () => {
			mocks.cameraUploadConfig = {
				enabled: true,
				remoteDir: { inner: [{ uuid: VALID_UUID }] }
			}
			setNav("/tabs/photos", {})

			const { result } = renderHook(() => useDrivePath())

			expect(result.current.type).toBe("photos")
			expect(result.current.uuid).toBe(VALID_UUID)
		})

		it("cameraUpload disabled → uuid=null", () => {
			mocks.cameraUploadConfig = {
				enabled: false,
				remoteDir: { inner: [{ uuid: VALID_UUID }] }
			}
			setNav("/tabs/photos", {})

			const { result } = renderHook(() => useDrivePath())

			expect(result.current.type).toBe("photos")
			expect(result.current.uuid).toBeNull()
		})

		it("cameraUpload enabled but remoteDir=null → uuid=null", () => {
			mocks.cameraUploadConfig = {
				enabled: true,
				remoteDir: null
			}
			setNav("/tabs/photos", {})

			const { result } = renderHook(() => useDrivePath())

			expect(result.current.type).toBe("photos")
			expect(result.current.uuid).toBeNull()
		})
	})
})

describe("useDrivePath — selectOptions/linked deserialization", () => {
	it("invalid base64/msgpack selectOptions is caught → selectOptions=undefined in DrivePath", () => {
		// driveSelect screen with invalid serialized data
		setNav("/driveSelect/" + VALID_UUID, { uuid: VALID_UUID, selectOptions: "not-valid-base64-!!!###" })

		const { result } = renderHook(() => useDrivePath())

		// Error swallowed → selectOptions undefined (not crash), type falls back to drive (no selectOptions)
		// The hook returns type=null (no selectOptions means the driveSelect check fails,
		// and the navigationId doesn't match any standalone drive/offline/etc branches)
		// Actually: isDriveSelectScreen=true but selectOptions=null → falls through to check
		// isDriveScreen etc. /driveSelect doesn't start with /tabs/drive → type=null
		expect(result.current.selectOptions).toBeUndefined()
	})

	it("invalid base64/msgpack linked param is caught → linked=undefined in DrivePath", () => {
		setNav("/linkedDir/" + VALID_UUID, { uuid: VALID_UUID, linked: "!!!invalid!!!" })

		const { result } = renderHook(() => useDrivePath())

		// linked parse fails → linked=null → isLinkedDirScreen check fails → falls through
		expect(result.current.linked).toBeUndefined()
	})

	it("valid selectOptions deserializes and all fields are forwarded", () => {
		const opts: SelectOptions = {
			type: "single",
			files: true,
			directories: true,
			intention: "select",
			items: [],
			id: "sel-abc",
			previewType: "image"
		}
		const serialized = serialize(opts)

		setNav("/driveSelect/" + VALID_UUID, { uuid: VALID_UUID, selectOptions: serialized })

		const { result } = renderHook(() => useDrivePath())

		const so = result.current.selectOptions!

		expect(so.type).toBe("single")
		expect(so.files).toBe(true)
		expect(so.directories).toBe(true)
		expect(so.intention).toBe("select")
		expect(so.id).toBe("sel-abc")
		expect(so.previewType).toBe("image")
	})

	it("selectOptions with unknown extra fields — only allowed fields are forwarded (field allowlist)", () => {
		// Serialize with extra field that should be stripped
		const raw = {
			type: "multiple",
			files: false,
			directories: true,
			intention: "move",
			items: [],
			id: "sel-xyz",
			// extra field that should be dropped
			__extra: "should-not-leak"
		}
		const serialized = serialize(raw)

		setNav("/driveSelect/" + VALID_UUID, { uuid: VALID_UUID, selectOptions: serialized })

		const { result } = renderHook(() => useDrivePath())

		const so = result.current.selectOptions!

		expect(so.id).toBe("sel-xyz")
		// The hook explicitly picks only the known fields — extra fields don't appear
		expect((so as unknown as Record<string, unknown>)["__extra"]).toBeUndefined()
	})

	it("linked param with valid round-trip returns { uuid, key, rootName, password? }", () => {
		const linked: Linked = {
			uuid: VALID_UUID,
			key: "my-key",
			rootName: "Root",
			password: "hunter2"
		}
		const serialized = serialize(linked)

		setNav("/linkedDir/" + VALID_UUID, { uuid: VALID_UUID, linked: serialized })

		const { result } = renderHook(() => useDrivePath())

		expect(result.current.linked).toEqual({
			uuid: VALID_UUID,
			key: "my-key",
			rootName: "Root",
			password: "hunter2"
		})
	})

	it("selectOptions missing required fields (id, type) still returns the partial object without throwing", () => {
		// Partial object — missing 'id' and 'type'
		const partial = {
			files: true,
			directories: false,
			intention: "move",
			items: []
		}
		const serialized = serialize(partial)

		setNav("/driveSelect/" + VALID_UUID, { uuid: VALID_UUID, selectOptions: serialized })

		// Should not throw — returns without error (missing id/type means no-crash)
		const { result } = renderHook(() => useDrivePath())

		// isDriveSelectScreen=true and the partial selectOptions is truthy (not null), so the
		// hook still returns type='drive' with the partial selectOptions attached.
		// The missing fields come through as undefined — not stripped, not throwing.
		expect(result.current.type).toBe("drive")
		expect(result.current.uuid).toBe(VALID_UUID)
		// The partial selectOptions object IS attached (truthy deserialization succeeded)
		expect(result.current.selectOptions).toBeDefined()
		// The missing required fields arrive as undefined — no silent default, no crash
		expect(result.current.selectOptions?.id).toBeUndefined()
		expect(result.current.selectOptions?.type).toBeUndefined()
		// The fields that were supplied survive round-trip
		expect(result.current.selectOptions?.files).toBe(true)
		expect(result.current.selectOptions?.intention).toBe("move")
	})
})
