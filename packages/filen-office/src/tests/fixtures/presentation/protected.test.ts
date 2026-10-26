import { unzipSync } from "fflate"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CfbFile } from "@filen/office/core/cfb"
import { isEncryptedContainer, readEncryptedContainer } from "@filen/office/core/encryption"
import { bytesSource } from "@filen/office/core/opc"
import { verifyProtectionPassword } from "@filen/office/dom"
import { classifyDataSpaces, encryptedPackageVerdict } from "@filen/office/dom/encryption"
import { OpenXmlSdk, openXmlSdkMissing } from "../../oracles/openXmlSdk"
import {
	ENCRYPTED_ODP,
	GETTEXT_POT,
	MODIFY_PASSWORD,
	MODIFY_SPIN_COUNT,
	ROUTING_SOURCE,
	irmPptx,
	minimalPptx,
	modifyVerifierPptx,
	routingCopies
} from "./protected"

describe("protected presentation fixtures", () => {
	it("stores the ODP's content and styles encrypted, with only the manifest and mimetype in the clear", () => {
		const entries = unzipSync(new Uint8Array(readFileSync(ENCRYPTED_ODP)))
		const manifest = new TextDecoder().decode(entries["META-INF/manifest.xml"])
		const mimetype = new TextDecoder().decode(entries["mimetype"])

		expect(mimetype).toBe("application/vnd.oasis.opendocument.presentation")

		for (const part of ["content.xml", "styles.xml"]) {
			expect(manifest).toMatch(new RegExp(`full-path="${part}"[^>]*>\\s*<manifest:encryption-data`))
			expect(new TextDecoder().decode(entries[part]).includes("<office:")).toBe(false)
		}
	})

	it("builds an IRM package the encryption gate refuses as rights-managed", async () => {
		const bytes = await irmPptx()
		const cfb = await CfbFile.open(bytesSource(bytes))

		expect(isEncryptedContainer(cfb)).toBe(true)
		expect(classifyDataSpaces((await readEncryptedContainer(cfb)).dataSpaces)).toBe("rightsManaged")
		expect(await encryptedPackageVerdict(bytesSource(bytes))).toBe("rightsManaged")
		expect(await irmPptx()).toEqual(bytes)
	})

	it("builds a modifyVerifier deck whose hash accepts its password only", { timeout: 30_000 }, async () => {
		const bytes = modifyVerifierPptx()
		const presentation = new TextDecoder().decode(unzipSync(bytes)["ppt/presentation.xml"])
		const match =
			/<p:modifyVerifier algorithmName="SHA-512" hashValue="([^"]+)" saltValue="([^"]+)" spinValue="(\d+)"\/><\/p:presentation>/.exec(
				presentation
			)

		expect(match).not.toBeNull()

		const hash = {
			algorithm: "SHA-512",
			hash: match?.[1] ?? "",
			salt: match?.[2] ?? "",
			spinCount: Number(match?.[3]),
			input: "plain"
		} as const

		expect(hash.spinCount).toBe(MODIFY_SPIN_COUNT)
		expect(await verifyProtectionPassword(hash, MODIFY_PASSWORD)).toBe("correct")
		expect(await verifyProtectionPassword(hash, `${MODIFY_PASSWORD}!`)).toBe("wrong")
		expect(modifyVerifierPptx()).toEqual(bytes)
	})

	it("keeps a gettext template that is plain text, not a compound file", () => {
		const bytes = readFileSync(GETTEXT_POT)

		expect(bytes.subarray(0, 4)).not.toEqual(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
		expect(bytes.toString("utf8")).toMatch(/^msgid ""$/m)
	})

	describe("routing copies", () => {
		let scratch: string

		beforeAll(() => {
			scratch = mkdtempSync(join(tmpdir(), "filen-office-routing-"))
		})

		afterAll(() => rmSync(scratch, { recursive: true, force: true }))

		it("copies the pinned corpus .ppt as .pps and .pot", context => {
			const copies = routingCopies(scratch)

			if (copies === undefined) {
				context.skip()

				return
			}

			for (const path of [copies.pps, copies.pot]) {
				expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(ROUTING_SOURCE.sha256)
			}
		})
	})
})

describe.skipIf(openXmlSdkMissing() !== undefined)("generated decks against the Open XML SDK validator", () => {
	let sdk: OpenXmlSdk
	let scratch: string

	beforeAll(() => {
		sdk = new OpenXmlSdk()
		scratch = mkdtempSync(join(tmpdir(), "filen-office-protected-"))
	})

	afterAll(async () => {
		await sdk.close()
		rmSync(scratch, { recursive: true, force: true })
	})

	it("finds no error in the plain and the modifyVerifier deck", { timeout: 60_000 }, async () => {
		for (const [name, bytes] of [
			["plain.pptx", minimalPptx("Plain")],
			["reserved.pptx", modifyVerifierPptx()]
		] as const) {
			const path = join(scratch, name)

			writeFileSync(path, bytes)

			const result = await sdk.validate(path)

			expect(result.fatal, name).toBeUndefined()
			expect(result.errors, name).toEqual([])
		}
	})
})
