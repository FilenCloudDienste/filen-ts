import { useEffect, useId, useRef, useState, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SecretInput } from "@/components/ui/secretInput"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { DriveFilePickerDialog } from "@/features/drive/components/driveFilePickerDialog"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { openPdfSigner, type PdfSigner, type PdfSignerFileSource } from "@/features/pdf/signing/signerClient"
import {
	SIGNING_APPEARANCE_KEYS,
	SIGNING_APPEARANCES,
	SIGNING_CERTIFY,
	SIGNING_CERTIFY_KEYS,
	SIGNING_ERROR_KEYS,
	SIGNING_REASON_KEYS,
	SIGNING_REASONS,
	certificateValidity,
	certifyLevel,
	isCertificateFileName,
	signerDisplayName,
	type CertificateValidity,
	type PdfCertificateSigning,
	type SigningAppearance,
	type SigningCertify,
	type SigningErrorKey,
	type SigningReason
} from "@/features/pdf/signing/signing.logic"
import type { PdfSignerSummary } from "@/features/pdf/workers/pdfSignerCore"
import { formatShortDate } from "@/lib/formatDate"

export interface CertificateSigningDialogProps {
	// False once the document has a signature: only the first may certify.
	canCertify: boolean
	// A visual signature (drawn or image) is available to show beside the details.
	hasVisual: boolean
	// The signer, unlocked, and the choices: the dialog closes and the caller has the user place the signature, signs,
	// then terminates the signer (also when placing is cancelled).
	onPlace: (signing: PdfCertificateSigning) => void
	onClose: () => void
}

interface LoadedCertificate {
	readonly name: string
	readonly signer: PdfSigner
}

// Signing with a certificate: the .p12/.pfx file (from the drive or the device; read straight into the signer worker),
// its password (used once, kept nowhere: a non-credential secret field), the signer it names with its validity, the
// reason, location, what the signature shows and an optional certification. Mounted anew for each opening; closing
// it terminates a signer not handed over.
export function CertificateSigningDialog({ canCertify, hasVisual, onPlace, onClose }: CertificateSigningDialogProps) {
	const { t } = useTranslation(["preview", "common"])
	const id = useId()
	const [certificate, setCertificate] = useState<LoadedCertificate | null>(null)
	const [loading, setLoading] = useState(false)
	const [picking, setPicking] = useState(false)
	const [password, setPassword] = useState("")
	const [unlocking, setUnlocking] = useState(false)
	const [summary, setSummary] = useState<PdfSignerSummary | null>(null)
	// Judged when unlocked.
	const [validity, setValidity] = useState<CertificateValidity>("valid")
	const [error, setError] = useState<SigningErrorKey | null>(null)
	const [reason, setReason] = useState<SigningReason>("approve")
	const [location, setLocation] = useState("")
	const [appearance, setAppearance] = useState<SigningAppearance>(hasVisual ? "visual" : "nameDate")
	const [certify, setCertify] = useState<SigningCertify>("none")
	const fileInput = useRef<HTMLInputElement>(null)
	// The signer this dialog owns until it hands it over, and whether the dialog is still mounted.
	const owned = useRef<PdfSigner | null>(null)
	const mounted = useRef(true)
	const busy = loading || unlocking

	// Set on every mount: a remount (StrictMode, a reused subtree) must not leave the dialog believing it is gone.
	useEffect(() => {
		mounted.current = true

		return () => {
			mounted.current = false
			owned.current?.terminate()
			owned.current = null
		}
	}, [])

	const load = async (name: string, source: PdfSignerFileSource): Promise<void> => {
		owned.current?.terminate()
		owned.current = null
		setCertificate(null)
		setSummary(null)
		setError(null)
		setLoading(true)

		const result = await openPdfSigner(source)

		if (!mounted.current) {
			if (result.ok) {
				result.signer.terminate()
			}

			return
		}

		setLoading(false)

		if (!result.ok) {
			setError(SIGNING_ERROR_KEYS[result.reason])

			return
		}

		owned.current = result.signer
		setCertificate({ name, signer: result.signer })
	}

	const unlock = (event: SubmitEvent): void => {
		event.preventDefault()

		if (certificate === null || busy) {
			return
		}

		setUnlocking(true)
		setError(null)
		void certificate.signer.unlock(password).then(result => {
			setUnlocking(false)

			if (result.ok) {
				setSummary(result.summary)
				setValidity(certificateValidity(result.summary.signer, Date.now()))
				setPassword("")
			} else {
				setError(SIGNING_ERROR_KEYS[result.reason])
			}
		})
	}

	const place = (): void => {
		if (certificate === null || summary === null) {
			return
		}

		// Handed over: the caller terminates it from now on.
		owned.current = null
		onPlace({
			signer: certificate.signer,
			summary,
			options: {
				reason: reason === "none" ? null : t(SIGNING_REASON_KEYS[reason]),
				location: location.trim().length === 0 ? null : location.trim(),
				appearance,
				certify: canCertify ? certifyLevel(certify) : null
			}
		})
	}

	return (
		<>
			<Dialog
				open
				onOpenChange={next => {
					if (!next) {
						onClose()
					}
				}}
			>
				<DialogContent
					data-preview-surface
					className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
				>
					<DialogHeader>
						<DialogTitle>{t("previewPdfSigningTitle")}</DialogTitle>
						<DialogDescription>{t("previewPdfSigningDescription")}</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-5">
						<Field>
							<FieldLabel>{t("previewPdfSigningCertificate")}</FieldLabel>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => {
										setPicking(true)
									}}
								>
									{t("previewPdfSigningFromFilen")}
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => {
										fileInput.current?.click()
									}}
								>
									{t("previewPdfSigningFromDevice")}
								</Button>
								<input
									ref={fileInput}
									type="file"
									accept=".p12,.pfx,application/x-pkcs12"
									className="hidden"
									data-testid="pdf-signing-device-file"
									onChange={event => {
										const file = event.currentTarget.files?.[0]

										event.currentTarget.value = ""

										if (file !== undefined) {
											void load(file.name, { kind: "device", file })
										}
									}}
								/>
							</div>
							{loading ? (
								<FieldDescription className="flex items-center gap-2">
									<Spinner className="size-3.5" />
									{t("previewPdfSigningLoading")}
								</FieldDescription>
							) : certificate !== null ? (
								<FieldDescription className="truncate">{certificate.name}</FieldDescription>
							) : null}
						</Field>
						{certificate !== null && summary === null ? (
							<form
								onSubmit={unlock}
								className="flex flex-col gap-2"
							>
								<Field>
									<FieldLabel htmlFor={`${id}-password`}>{t("previewPdfSigningPassword")}</FieldLabel>
									<div className="flex gap-2">
										<SecretInput
											id={`${id}-password`}
											value={password}
											autoFocus
											disabled={unlocking}
											aria-invalid={error === "previewPdfSigningErrorPassword" ? true : undefined}
											onChange={event => {
												setPassword(event.currentTarget.value)
											}}
										/>
										<Button
											type="submit"
											disabled={unlocking}
										>
											{unlocking ? <Spinner className="size-3.5" /> : null}
											{unlocking ? t("previewPdfSigningUnlocking") : t("previewPdfSigningUnlock")}
										</Button>
									</div>
									<FieldDescription>{t("previewPdfSigningPasswordNotStored")}</FieldDescription>
								</Field>
							</form>
						) : null}
						{error === null ? null : <FieldError>{t(error)}</FieldError>}
						{summary === null ? null : (
							<>
								<div className="flex flex-col gap-1 rounded-md border p-3 text-sm">
									<p className="font-medium">
										{t("previewPdfSigningSigner", { name: signerDisplayName(summary.signer) })}
									</p>
									<p className="text-muted-foreground">
										{t("previewPdfSigningIssuer", {
											issuer:
												summary.chain[1] === undefined ? summary.signer.issuer : signerDisplayName(summary.chain[1])
										})}
									</p>
									<p className="text-muted-foreground">
										{t("previewPdfSigningExpires", { date: formatShortDate(summary.signer.notAfter) })}
									</p>
									{validity === "expired" ? (
										<p className="text-destructive">
											{t("previewPdfSigningExpired", { date: formatShortDate(summary.signer.notAfter) })}
										</p>
									) : null}
									{validity === "notYetValid" ? (
										<p className="text-destructive">
											{t("previewPdfSigningNotYetValid", { date: formatShortDate(summary.signer.notBefore) })}
										</p>
									) : null}
									{summary.signer.selfSigned ? (
										<p className="text-muted-foreground">{t("previewPdfSigningSelfSigned")}</p>
									) : null}
								</div>
								<ChoiceField
									id={`${id}-reason`}
									label={t("previewPdfSigningReason")}
									value={reason}
									choices={SIGNING_REASONS.map(choice => ({ value: choice, label: t(SIGNING_REASON_KEYS[choice]) }))}
									onChange={setReason}
								/>
								<Field>
									<FieldLabel htmlFor={`${id}-location`}>{t("previewPdfSigningLocation")}</FieldLabel>
									<Input
										id={`${id}-location`}
										value={location}
										maxLength={200}
										placeholder={t("previewPdfSigningLocationPlaceholder")}
										onChange={event => {
											setLocation(event.currentTarget.value)
										}}
									/>
								</Field>
								<ChoiceField
									id={`${id}-appearance`}
									label={t("previewPdfSigningAppearance")}
									value={appearance}
									choices={SIGNING_APPEARANCES.filter(choice => hasVisual || choice !== "visual").map(choice => ({
										value: choice,
										label: t(SIGNING_APPEARANCE_KEYS[choice])
									}))}
									onChange={setAppearance}
								/>
								<ChoiceField
									id={`${id}-certify`}
									label={t("previewPdfSigningCertify")}
									value={canCertify ? certify : "none"}
									disabled={!canCertify}
									description={canCertify ? undefined : t("previewPdfSigningCertifyUnavailable")}
									choices={SIGNING_CERTIFY.map(choice => ({ value: choice, label: t(SIGNING_CERTIFY_KEYS[choice]) }))}
									onChange={setCertify}
								/>
							</>
						)}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
						>
							{t("common:cancel")}
						</Button>
						<Button
							type="button"
							disabled={summary === null}
							onClick={place}
						>
							{t("previewPdfSigningPlace")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{picking ? (
				<DriveFilePickerDialog
					title={t("previewPdfSigningPickerTitle")}
					description={t("previewPdfSigningPickerDescription")}
					accept={item => isCertificateFileName(driveItemName(item))}
					onPick={item => {
						// The picker closes at once; the dialog shows the reading.
						setPicking(false)

						return load(driveItemName(item), { kind: "drive", file: narrowToAnyFile(item) })
					}}
					onClose={() => {
						setPicking(false)
					}}
				/>
			) : null}
		</>
	)
}

interface ChoiceFieldProps<T extends string> {
	id: string
	label: string
	value: T
	choices: readonly { readonly value: T; readonly label: string }[]
	disabled?: boolean | undefined
	description?: string | undefined
	onChange: (value: T) => void
}

function ChoiceField<T extends string>({ id, label, value, choices, disabled, description, onChange }: ChoiceFieldProps<T>) {
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				items={choices}
				value={value}
				disabled={disabled}
				onValueChange={next => {
					const found = choices.find(choice => choice.value === next)

					if (found !== undefined) {
						onChange(found.value)
					}
				}}
			>
				<SelectTrigger
					id={id}
					className="w-full"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{choices.map(choice => (
						<SelectItem
							key={choice.value}
							value={choice.value}
						>
							{choice.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
		</Field>
	)
}
