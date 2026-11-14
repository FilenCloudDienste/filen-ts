// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PdfSignatureInfo, PdfSignatureReport } from "@filen/office/core/pdfsign"
import type { PdfDocument } from "@filen/office/dom/pdf"

const { verifier } = vi.hoisted(() => ({ verifier: { current: null as null | ((...args: unknown[]) => Promise<PdfSignatureReport>) } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
	})
}))

const { PdfSignatureStatus } = await import("@/features/pdf/signatures/pdfSignatureStatus")
const { signatureBanner } = await import("@/features/pdf/signatures/signatureStatus.logic")

function info(overrides: Partial<PdfSignatureInfo>): PdfSignatureInfo {
	return {
		field: "Signature1",
		page: 0,
		rect: [0, 0, 10, 10],
		kind: "signature",
		subFilter: "ETSI.CAdES.detached",
		state: "unchanged",
		invalidReason: null,
		unverifiableReason: null,
		changes: null,
		signedLength: 100,
		revision: 2,
		signer: {
			subject: "CN=Ada",
			issuer: "CN=Root",
			commonName: "Ada",
			organization: null,
			serial: "01",
			notBefore: 0,
			notAfter: 1,
			selfSigned: false
		},
		chain: [],
		name: null,
		reason: null,
		location: null,
		contactInfo: null,
		claimedTime: Date.UTC(2026, 0, 1),
		timestampTime: null,
		certification: null,
		digest: "SHA-256",
		algorithm: "RSA 2048",
		expiredAtClaimedTime: false,
		notYetValidAtClaimedTime: false,
		...overrides
	}
}

const report = (...signatures: PdfSignatureInfo[]): PdfSignatureReport => ({ signatures, revisions: 3, dss: false })

function pdf(signatures: unknown[] | null): PdfDocument {
	return { getSignatures: () => Promise.resolve(signatures) } as unknown as PdfDocument
}

const SIGNED = [{ fieldName: "Signature1", byteRange: [0, 10, 20, 80] }]

describe("signatureBanner", () => {
	it("summarises by the most serious signature", () => {
		expect(signatureBanner(report())).toBeNull()
		expect(signatureBanner(report(info({})))).toMatchObject({
			key: "previewPdfSignatureBannerUnchanged",
			name: "Ada",
			signedLength: null
		})
		expect(
			signatureBanner(report(info({}), info({ state: "changed", changes: { allowed: false, kinds: ["content"] }, signedLength: 50 })))
		).toMatchObject({ key: "previewPdfSignatureBannerChangedNotAllowed", signedLength: 50 })
		expect(signatureBanner(report(info({ state: "invalid", invalidReason: "digestMismatch" })))).toMatchObject({
			key: "previewPdfSignatureBannerInvalid",
			reason: "previewPdfSignatureInvalidDigest"
		})
		expect(
			signatureBanner(report(info({ state: "unverifiable", unverifiableReason: "algorithm", signer: null, name: "Bob" })))
		).toMatchObject({
			key: "previewPdfSignatureBannerUnverifiable",
			name: "Bob",
			reason: "previewPdfSignatureUnverifiableAlgorithm"
		})
	})
})

describe("PdfSignatureStatus", () => {
	it("shows nothing and never verifies an unsigned document", async () => {
		const verify = vi.fn(() => Promise.resolve(report()))

		verifier.current = verify

		const { container } = render(
			<PdfSignatureStatus
				verify={verifier.current}
				document={pdf(null)}
			/>
		)

		await waitFor(() => {
			expect(container.textContent).toBe("")
		})
		expect(verify).not.toHaveBeenCalled()
	})

	it("passes pdf.js's signatures to the verifier and shows the result with its details", async () => {
		const verify = vi.fn(() => Promise.resolve(report(info({}))))

		verifier.current = verify
		render(
			<PdfSignatureStatus
				verify={verifier.current}
				document={pdf(SIGNED)}
			/>
		)

		expect(await screen.findByText(/previewPdfSignatureBannerUnchanged/)).toBeTruthy()
		expect(verify).toHaveBeenCalledWith([{ name: "Signature1", byteRange: [0, 10, 20, 80] }], expect.any(AbortSignal))

		fireEvent.click(screen.getByText("previewPdfSignatureDetails"))

		expect(await screen.findByText("previewPdfSignatureSignerNotVerified")).toBeTruthy()
		expect(screen.getByText(/previewPdfSignatureClaimedTime/)).toBeTruthy()
		expect(screen.getByText("previewPdfSignatureNoTimestamp")).toBeTruthy()
	})

	it("offers the signed version of a document changed after signing", async () => {
		const onViewSignedVersion = vi.fn()

		verifier.current = () =>
			Promise.resolve(report(info({ state: "changed", changes: { allowed: true, kinds: ["form"] }, signedLength: 64 })))
		render(
			<PdfSignatureStatus
				verify={verifier.current}
				document={pdf(SIGNED)}
				onViewSignedVersion={onViewSignedVersion}
			/>
		)

		fireEvent.click(await screen.findByText("previewPdfSignatureViewSigned"))

		expect(onViewSignedVersion).toHaveBeenCalledWith(64)
	})

	it("says when the check failed and checks again on retry", async () => {
		const verify = vi.fn(() => Promise.reject(new Error("offline")))

		verifier.current = verify
		render(
			<PdfSignatureStatus
				verify={verifier.current}
				document={pdf(SIGNED)}
			/>
		)

		fireEvent.click(await screen.findByText("previewPdfSignatureRetry"))

		await waitFor(() => {
			expect(verify).toHaveBeenCalledTimes(2)
		})
	})
})
