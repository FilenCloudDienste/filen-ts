import { describe, expect, test } from "vitest"
import { classifyPdfError } from "@/components/pdfPreview/errors"

function pdfjsError(name: string, extra: Record<string, unknown> = {}): unknown {
	// Duck-typed the way the classifier sees them: these classes live in the DOM bundle, so the value
	// that reaches the classifier has crossed a boundary and cannot be matched with instanceof.
	return {
		name,
		message: "some detail the document may control",
		...extra
	}
}

describe("classifyPdfError", () => {
	test("treats a password request as a prompt, not a failure", () => {
		// Rendering "could not open this file" for a document that merely needs a password is the
		// specific mistake this separation prevents.
		expect(classifyPdfError(pdfjsError("PasswordException", { code: 1 }))).toStrictEqual({
			type: "password",
			reason: "required"
		})

		expect(classifyPdfError(pdfjsError("PasswordException", { code: 2 }))).toStrictEqual({
			type: "password",
			reason: "incorrect"
		})
	})

	test("maps a corrupt document", () => {
		expect(classifyPdfError(pdfjsError("InvalidPDFException"))).toStrictEqual({
			type: "error",
			kind: "invalidDocument"
		})
	})

	test("maps a transport failure through the class 6.x actually uses", () => {
		// MissingPDFException and UnexpectedResponseException no longer exist; matching on them would
		// silently never fire.
		expect(classifyPdfError(pdfjsError("ResponseException"))).toStrictEqual({
			type: "error",
			kind: "transportFailed"
		})

		expect(classifyPdfError(pdfjsError("MissingPDFException"))).toStrictEqual({
			type: "error",
			kind: "unknown"
		})
	})

	test("treats cancellation as expected, not as an error", () => {
		// Scrolling away from a page cancels its render; surfacing that would put an error on screen
		// during ordinary scrolling.
		expect(classifyPdfError(pdfjsError("RenderingCancelledException"))).toStrictEqual({ type: "aborted" })
		expect(classifyPdfError(pdfjsError("AbortException"))).toStrictEqual({ type: "aborted" })
	})

	test("falls back to unknown for anything unrecognised", () => {
		for (const value of [null, undefined, "a string", 42, {}, pdfjsError("TypeError")]) {
			expect(classifyPdfError(value)).toStrictEqual({
				type: "error",
				kind: "unknown"
			})
		}
	})

	test("never propagates the pdf.js message", () => {
		const classification = classifyPdfError(pdfjsError("InvalidPDFException"))

		expect(JSON.stringify(classification)).not.toContain("document may control")
	})
})
