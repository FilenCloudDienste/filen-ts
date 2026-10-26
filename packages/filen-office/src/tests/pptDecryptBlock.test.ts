import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { Rc4 } from "../core/crypto/legacy"
import { cryptoApiBlockKey, docKey, type DocDecryption } from "../core/doc/decrypt"
import { DocError } from "../core/doc/errors"
import { cryptoApiKeys, encryptionHeader } from "./docDecryptFixtures"

// The CryptoAPI RC4 key's single-stream decryption ([MS-PPT] §2.3.7): a persist object is one key stream from the key
// of its persist id, never rekeyed every 512 bytes as the Word and Excel streams are.

function decryption(password: string): DocDecryption {
	return { password, sha1: data => Promise.resolve(new Uint8Array(createHash("sha1").update(data).digest())) }
}

function encrypt(plain: Uint8Array, key: Uint8Array): Uint8Array {
	const out = new Uint8Array(plain.length)

	new Rc4(key).apply(plain, out)

	return out
}

const PLAIN = Uint8Array.from({ length: 1500 }, (_, k) => (k * 7 + 3) & 0xff)

describe("CryptoAPI block key", () => {
	for (const keySize of [0, 56, 128]) {
		it(`decrypts a whole range with one block's key stream (KeySize ${String(keySize)})`, async () => {
			const header = encryptionHeader({ scheme: "cryptoApiRc4", password: "hello", keySize })
			const key = await cryptoApiBlockKey(header, decryption("hello"))
			const cipher = encrypt(PLAIN, cryptoApiKeys("hello", keySize)(37))

			expect(await key.decryptBlock(cipher, 37)).toEqual(PLAIN)
			// The 512-byte rekeying stream agrees only where block 0 covers it.
			const zero = encrypt(PLAIN, cryptoApiKeys("hello", keySize)(0))
			const single = await key.decryptBlock(zero, 0)
			const rekeyed = await key.decrypt(zero, 0)

			expect(single.subarray(0, 512)).toEqual(rekeyed.subarray(0, 512))
			expect(single).toEqual(PLAIN)
			expect(rekeyed.subarray(512)).not.toEqual(PLAIN.subarray(512))
		})
	}

	it("leaves its input untouched", async () => {
		const header = encryptionHeader({ scheme: "cryptoApiRc4", password: "pw", keySize: 128 })
		const key = await cryptoApiBlockKey(header, decryption("pw"))
		const cipher = encrypt(PLAIN, cryptoApiKeys("pw", 128)(1))
		const copy = cipher.slice()

		await key.decryptBlock(cipher, 1)
		expect(cipher).toEqual(copy)
	})

	it("refuses a wrong password, as the stream key does", async () => {
		const header = encryptionHeader({ scheme: "cryptoApiRc4", password: "right", keySize: 128 })

		await expect(cryptoApiBlockKey(header, decryption("wrong"))).rejects.toMatchObject({ code: "wrongPassword" })
		await expect(docKey("cryptoApiRc4", header.length, header, decryption("wrong"))).rejects.toBeInstanceOf(DocError)
	})

	it("refuses a truncated header as damaged", async () => {
		const header = encryptionHeader({ scheme: "cryptoApiRc4", password: "pw", keySize: 128 })

		await expect(cryptoApiBlockKey(header.subarray(0, 40), decryption("pw"))).rejects.toMatchObject({ code: "corrupt" })
	})
})
