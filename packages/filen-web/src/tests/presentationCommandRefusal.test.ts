import { describe, expect, it } from "vitest"
import { PresentationCallError } from "@filen/office/dom/presentation"
import { commandFailure, refusalToTell } from "@/features/presentation/hooks/usePresentationSession"

// A command the session could not answer: its reason as the worker gave it, and only a refusal the user's change met
// is told (a command that met a closing session, the file closed meanwhile, tells nothing).

describe("a command's failure", () => {
	it("keeps the reason a worker call error carries", () => {
		expect(commandFailure(new PresentationCallError("closed", "command"))).toEqual({ ok: false, refusal: "closed" })
		expect(commandFailure(new Error("boom"))).toEqual({ ok: false, refusal: "failed" })
	})

	it("tells every refusal but one met by a closed session", () => {
		expect(refusalToTell("closed")).toBe(false)
		expect(refusalToTell("failed")).toBe(true)
		expect(refusalToTell("locked")).toBe(true)
	})
})
