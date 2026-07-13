import { vi, describe, it, expect } from "vitest"
import { Buffer } from "buffer"
import crypto from "crypto"

// authFileKey imports native/platform modules at the top; stub them so the pure seal/open crypto can
// be exercised in a node env. sealAuthFile/openAuthFile only use `crypto` (real node) + Buffer.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }))
vi.mock("react-native-quick-crypto", () => ({ Buffer }))
vi.mock("expo-secure-store", () => ({
	getItemAsync: vi.fn(),
	setItemAsync: vi.fn(),
	deleteItemAsync: vi.fn(),
	AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlockThisDeviceOnly"
}))
vi.mock("@/modules/filen-auth-key", () => ({
	getOrCreateDek: vi.fn(),
	purgeDek: vi.fn()
}))

import { sealAuthFile, openAuthFile } from "@/features/settings/authFileKey"

describe("authFileKey seal/open (must match the Rust decrypt_auth_bytes format)", () => {
	it("round-trips a payload with the v1 layout: 0x01 || iv(12) || ciphertext || tag(16)", () => {
		const dek = crypto.randomBytes(32)
		const plaintext = JSON.stringify({ providerEnabled: true, sdkConfig: null })

		const sealed = sealAuthFile(plaintext, dek)

		expect(sealed[0]).toBe(0x01)
		expect(sealed.length).toBe(1 + 12 + Buffer.byteLength(plaintext, "utf-8") + 16)
		expect(openAuthFile(sealed, dek)).toBe(plaintext)
	})

	it("fails to open with the wrong key (GCM tag check)", () => {
		const sealed = sealAuthFile("hello", crypto.randomBytes(32))

		expect(() => openAuthFile(sealed, crypto.randomBytes(32))).toThrow()
	})

	it("rejects an unknown version byte", () => {
		const dek = crypto.randomBytes(32)
		const tampered = new Uint8Array(sealAuthFile("hello", dek))
		tampered[0] = 0x02

		expect(() => openAuthFile(tampered, dek)).toThrow()
	})

	it("rejects a truncated blob", () => {
		expect(() => openAuthFile(new Uint8Array([0x01, 0x00]), crypto.randomBytes(32))).toThrow()
	})
})
