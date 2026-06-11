/**
 * HARDENING suite for src/lib/secureStore.ts — contract tripwires added ahead of the
 * perf campaign (2026-06-11).
 *
 * What this file pins that secureStore.test.ts does not: the EXACT on-disk wire format,
 * cross-checked against an INDEPENDENT AES-256-GCM implementation in BOTH directions.
 * The existing suite round-trips through the lib's own code paths and checks only the
 * payload LENGTH — a payload-assembly rewrite that consistently byte-shuffled the
 * format on both the write and read side would stay green there while breaking every
 * EXISTING on-device store (whose files use the current layout: 12-byte IV ++
 * ciphertext ++ 16-byte authTag, AES-256-GCM, hex key, serializer plaintext).
 */
import { vi, describe, it, expect, beforeEach } from "vitest"
import nodeCrypto from "node:crypto"

vi.hoisted(() => {
	// Hoisted so it lands before the (ESM-hoisted) secureStore import — its module-level
	// singleton constructor throws without the fallback key.
	process.env["EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY"] = "hardening-fallback-key"
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-secure-store", async () => await import("@/tests/mocks/expoSecureStore"))

vi.mock("react-native-mmkv", async () => await import("@/tests/mocks/reactNativeMMKV"))

vi.mock("react-native-quick-crypto", async () => await import("@/tests/mocks/reactNativeQuickCrypto"))

vi.mock("@/lib/cache", () => ({
	default: {
		secureStore: new Map<string, unknown>()
	}
}))

vi.mock("@/lib/events", () => ({
	default: {
		emit: vi.fn(),
		subscribe: vi.fn(() => ({ remove: () => {} }))
	}
}))

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("@/lib/utils", () => ({}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForSdk: (path: string) => path
}))

import secureStore from "@/lib/secureStore"
import { fs } from "@/tests/mocks/expoFileSystem"
import { isAvailableAsync, getItemAsync, setItemAsync } from "@/tests/mocks/expoSecureStore"
import { mockMmkv } from "@/tests/mocks/reactNativeMMKV"
import { serialize, deserialize } from "@/lib/serializer"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SecureStoreInstance = any

const SecureStoreCtor = secureStore.constructor as new () => SecureStoreInstance

const STORE_FILE_URI = "file:///shared/group.io.filen.app/secureStore/v1/securestore.bin"

// A fixed, known encryption key (64 hex chars = 32 bytes) served by the expo-secure-store
// mock so both the lib and the independent implementation share it without capture
// machinery.
const FIXED_KEY_HEX = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

// INDEPENDENT decryptor — node:crypto only, no lib code. Encodes the pinned wire layout.
function independentDecrypt(bytes: Uint8Array, keyHex: string): Record<string, unknown> {
	const iv = bytes.subarray(0, 12)
	const authTag = bytes.subarray(bytes.length - 16)
	const ciphertext = bytes.subarray(12, bytes.length - 16)
	const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv)

	decipher.setAuthTag(authTag)

	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])

	return deserialize(plaintext.toString("utf-8")) as Record<string, unknown>
}

// INDEPENDENT encryptor — produces a file in the pinned wire layout from a plain record.
function independentEncrypt(record: Record<string, unknown>, keyHex: string): Uint8Array {
	const iv = nodeCrypto.randomBytes(12)
	const cipher = nodeCrypto.createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv)
	const ciphertext = Buffer.concat([cipher.update(Buffer.from(serialize(record), "utf-8")), cipher.final()])
	const authTag = cipher.getAuthTag()

	return new Uint8Array(Buffer.concat([iv, ciphertext, authTag]))
}

beforeEach(() => {
	fs.clear()
	isAvailableAsync.mockClear().mockResolvedValue(true)
	getItemAsync.mockClear().mockResolvedValue(FIXED_KEY_HEX)
	setItemAsync.mockClear().mockResolvedValue(undefined)
	mockMmkv.getString.mockClear().mockReturnValue(undefined)
	mockMmkv.set.mockClear()
})

describe("hardening — wire format pinned against an independent implementation", () => {
	it("a store written by the lib decrypts with independent node-crypto (12-IV ++ CT ++ 16-tag, GCM, hex key)", async () => {
		const store = new SecureStoreCtor()

		await store.init()

		await store.set("alpha", { nested: true, count: 42 })
		await store.set("beta", "plain-string")

		const fileBytes = fs.get(STORE_FILE_URI)

		expect(fileBytes).toBeInstanceOf(Uint8Array)

		const decrypted = independentDecrypt(fileBytes as Uint8Array, FIXED_KEY_HEX)

		expect(decrypted).toEqual({
			alpha: { nested: true, count: 42 },
			beta: "plain-string"
		})
	})

	it("a store written by INDEPENDENT node-crypto (the existing on-device layout) reads through the lib", async () => {
		const record = {
			"cameraUploadConfig:v1": { enabled: true, albumIds: ["a-1"] },
			biometric: "1234",
			loopMode: "track"
		}

		fs.set(STORE_FILE_URI, independentEncrypt(record, FIXED_KEY_HEX))

		const store = new SecureStoreCtor()

		await store.init()

		expect(await store.get("cameraUploadConfig:v1")).toEqual({ enabled: true, albumIds: ["a-1"] })
		expect(await store.get("biometric")).toBe("1234")
		expect(await store.get("loopMode")).toBe("track")
	})

	it("after a lib write on top of an independently-written store, the merged store still decrypts independently", async () => {
		fs.set(STORE_FILE_URI, independentEncrypt({ existing: "value" }, FIXED_KEY_HEX))

		const store = new SecureStoreCtor()

		await store.init()
		await store.set("added", 7)

		const decrypted = independentDecrypt(fs.get(STORE_FILE_URI) as Uint8Array, FIXED_KEY_HEX)

		expect(decrypted).toEqual({
			existing: "value",
			added: 7
		})
	})
})
