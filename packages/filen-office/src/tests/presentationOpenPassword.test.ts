import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openPptxCapability, pptxDecrypted, pptxPassword } from "../dom/presentation/engine/open/pptx"
import { agileStreams, encryptedOfficeFile } from "@filen/office/testing/encryption"
import { body, buildPptx, para, sp } from "./pptxFixtures"

// The open password and key of an encrypted deck are held only while its session is open: closing it (the package's
// release) drops both.

const PASSWORD = "Held only while open"

describe("an encrypted deck's password", () => {
	it("is held while the session is open and gone once it closes", async () => {
		const file = await encryptedOfficeFile(
			agileStreams(buildPptx({ slides: [{ shapes: sp(2, "T", undefined, "", body(para("Locked"))) }] }), PASSWORD, {
				spinCount: 1000
			})
		)
		const request = { source: bytesSource(file), sourceKind: "bytes", options: { format: "pptx", fileName: "deck.pptx" } }
		const outcome = await openPptxCapability.open({ ...request, password: PASSWORD } as never)

		if (outcome.kind !== "opened") throw new Error(JSON.stringify(outcome))

		expect(pptxPassword(outcome.deck)).toBe(PASSWORD)
		expect(pptxDecrypted(outcome.deck)).toBeDefined()

		outcome.package.release?.()

		expect(pptxPassword(outcome.deck)).toBeUndefined()
		expect(pptxDecrypted(outcome.deck)).toBeUndefined()
	})
})
