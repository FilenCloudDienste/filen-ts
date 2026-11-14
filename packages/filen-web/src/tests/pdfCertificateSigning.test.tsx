// @vitest-environment jsdom

import { StrictMode } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { PdfSignerUnlock } from "@/features/pdf/workers/pdfSignerCore"

const { opened } = vi.hoisted(() => ({
	opened: { calls: [] as unknown[], unlock: vi.fn<(password: string) => Promise<PdfSignerUnlock>>(), terminate: vi.fn() }
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, params?: Record<string, unknown>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
	})
}))

vi.mock("@/features/pdf/signing/signerClient", () => ({
	openPdfSigner: (source: unknown) => {
		opened.calls.push(source)

		return Promise.resolve({ ok: true, signer: { unlock: opened.unlock, sign: vi.fn(), terminate: opened.terminate } })
	}
}))

vi.mock("@/features/drive/components/driveFilePickerDialog", () => ({ DriveFilePickerDialog: () => null }))
vi.mock("@/features/drive/lib/download", () => ({ narrowToAnyFile: (item: unknown) => item }))

const { CertificateSigningDialog } = await import("@/features/pdf/signing/certificateSigningDialog")
const { SignatureInvalidationDialog } = await import("@/features/pdf/signing/signatureInvalidationDialog")

const signer = {
	subject: "CN=Ada Lovelace",
	issuer: "CN=Root",
	commonName: "Ada Lovelace",
	organization: null,
	serial: "01",
	notBefore: Date.UTC(2020, 0, 1),
	notAfter: Date.UTC(2021, 0, 1),
	selfSigned: true
}

function pickDeviceFile(): void {
	const input = screen.getByTestId("pdf-signing-device-file")

	fireEvent.change(input, { target: { files: [new File([new Uint8Array(4)], "ada.p12")] } })
}

describe("CertificateSigningDialog", () => {
	it("reads the picked file in the signer, unlocks it and hands the signer over with the choices", async () => {
		opened.calls.length = 0
		opened.unlock.mockResolvedValueOnce({ ok: false, reason: "password" }).mockResolvedValueOnce({
			ok: true,
			summary: { signer, chain: [signer], digest: "SHA-256", algorithm: "RSA 2048", capacity: 4000 }
		})

		const onPlace = vi.fn<(signing: unknown) => void>()

		render(
			<CertificateSigningDialog
				canCertify
				hasVisual={false}
				onPlace={onPlace}
				onClose={() => undefined}
			/>
		)

		expect(screen.getByRole("button", { name: "previewPdfSigningPlace" })).toHaveProperty("disabled", true)

		pickDeviceFile()

		const password = await screen.findByLabelText("previewPdfSigningPassword")

		expect(opened.calls).toHaveLength(1)
		expect(opened.calls[0]).toMatchObject({ kind: "device" })
		expect(screen.getByText("ada.p12")).toBeTruthy()
		// A non-credential secret field: never type=password, never autocompleted.
		expect(password.getAttribute("type")).toBe("text")
		expect(password.getAttribute("autocomplete")).toBe("off")
		expect(screen.getByText("previewPdfSigningPasswordNotStored")).toBeTruthy()

		fireEvent.change(password, { target: { value: "wrong" } })
		fireEvent.click(screen.getByRole("button", { name: "previewPdfSigningUnlock" }))
		expect(await screen.findByText("previewPdfSigningErrorPassword")).toBeTruthy()

		fireEvent.change(password, { target: { value: "right" } })
		fireEvent.click(screen.getByRole("button", { name: "previewPdfSigningUnlock" }))

		await screen.findByText(/previewPdfSigningSigner/)
		expect(opened.unlock).toHaveBeenLastCalledWith("right")
		expect(screen.getByText(/previewPdfSigningExpired/)).toBeTruthy()
		expect(screen.getByText("previewPdfSigningSelfSigned")).toBeTruthy()

		fireEvent.change(screen.getByLabelText("previewPdfSigningLocation"), { target: { value: "  Berlin " } })
		fireEvent.click(screen.getByRole("button", { name: "previewPdfSigningPlace" }))

		expect(onPlace).toHaveBeenCalledTimes(1)
		expect(onPlace.mock.lastCall?.[0]).toMatchObject({
			signer: { terminate: opened.terminate },
			summary: { algorithm: "RSA 2048" },
			options: { reason: "previewPdfSigningReasonApprove", location: "Berlin", appearance: "nameDate", certify: null }
		})
	})

	it("reads the certificate after a remount (StrictMode runs the mount effects twice)", async () => {
		opened.calls.length = 0
		opened.terminate.mockClear()

		render(
			<StrictMode>
				<CertificateSigningDialog
					canCertify
					hasVisual={false}
					onPlace={() => undefined}
					onClose={() => undefined}
				/>
			</StrictMode>
		)

		pickDeviceFile()

		expect(await screen.findByLabelText("previewPdfSigningPassword")).toBeTruthy()
		expect(opened.terminate).not.toHaveBeenCalled()
	})

	it("terminates a signer it still owns when it closes", async () => {
		opened.terminate.mockClear()

		const view = render(
			<CertificateSigningDialog
				canCertify={false}
				hasVisual
				onPlace={() => undefined}
				onClose={() => undefined}
			/>
		)

		pickDeviceFile()
		await screen.findByLabelText("previewPdfSigningPassword")
		view.unmount()

		await waitFor(() => {
			expect(opened.terminate).toHaveBeenCalledTimes(1)
		})
	})
})

describe("SignatureInvalidationDialog", () => {
	it("states how many signatures the save invalidates and focuses Cancel", () => {
		const onConfirm = vi.fn()

		render(
			<SignatureInvalidationDialog
				open
				count={2}
				pending={false}
				onOpenChange={() => undefined}
				onConfirm={onConfirm}
			/>
		)

		expect(screen.getByText('previewPdfSigningInvalidate {"count":2}')).toBeTruthy()
		expect(document.activeElement?.textContent).toBe("common:cancel")

		fireEvent.click(screen.getByRole("button", { name: "previewPdfSigningInvalidateConfirm" }))
		expect(onConfirm).toHaveBeenCalledTimes(1)
	})
})
