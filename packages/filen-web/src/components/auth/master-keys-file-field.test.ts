import { describe, expect, it } from "vitest"
import { readMasterKeysFile, type MasterKeysFileLike } from "@/components/auth/master-keys-file-field.logic"

function fakeFile(name: string, text: () => Promise<string>): MasterKeysFileLike {
	return { name, text }
}

describe("readMasterKeysFile (master-keys file field read wiring)", () => {
	it("resolves the file's name alongside its text content, unmodified", async () => {
		const file = fakeFile("master-keys.txt", () => Promise.resolve("_VALID_FILEN_MASTERKEY_deadbeef@123_VALID_FILEN_MASTERKEY_"))

		await expect(readMasterKeysFile(file)).resolves.toEqual({
			fileName: "master-keys.txt",
			text: "_VALID_FILEN_MASTERKEY_deadbeef@123_VALID_FILEN_MASTERKEY_"
		})
	})

	it("passes base64-looking content through unparsed — the SDK sniffs the format, not this field", async () => {
		const file = fakeFile("master-keys-b64.txt", () => Promise.resolve("X1ZBTElEX0ZJTEVOX01BU1RFUktFWV8="))

		await expect(readMasterKeysFile(file)).resolves.toEqual({
			fileName: "master-keys-b64.txt",
			text: "X1ZBTElEX0ZJTEVOX01BU1RFUktFWV8="
		})
	})

	it("propagates a read failure instead of swallowing it", async () => {
		const file = fakeFile("master-keys.txt", () => Promise.reject(new Error("read failed")))

		await expect(readMasterKeysFile(file)).rejects.toThrow("read failed")
	})
})
