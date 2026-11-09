import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { FileLockIcon, LockIcon } from "lucide-react"
import type { DocxDocumentProtection, DocxProtectionEdit, DocxProtectionMode, DocxProtectionSetting } from "@filen/office/core/docx/edit"
import { hashDocumentProtectionPassword, verifyProtectionPassword } from "@filen/office/dom"
import { FormDialog } from "@/components/dialogs/formDialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { SecretInput } from "@/components/ui/secretInput"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { DocxPasswordPrompt, type PasswordVerdict } from "@/features/preview/components/docxPasswordPrompt"
import { log } from "@/lib/log"

// Word's Review > Protect: Restrict Editing (Start Enforcing Protection, with an optional password typed twice) and
// Stop Protection (the password checked first where the protection has one), and Lock Tracking (tracked changes
// protection) with Unlock Tracking. Passwords are hashed and checked on this thread in slices (dom/protection.ts);
// they are never logged or kept.

export interface DocxProtectionControls {
	// What applies now ("readOnly" too for a document it keeps view-only).
	readonly mode: DocxProtectionMode
	// Whether protection can be started (the document is open for editing).
	readonly canStart: boolean
	// The protection to stop and its password, read when asked (it parses the settings part).
	readonly read: () => DocxDocumentProtection | undefined
	// Starts `setting`, or stops the protection (undefined).
	readonly set: (setting: DocxProtectionSetting | undefined) => void
}

const EDITS: readonly { readonly edit: DocxProtectionEdit; readonly key: ProtectKey }[] = [
	{ edit: "readOnly", key: "previewDocxRestrictReadOnly" },
	{ edit: "trackedChanges", key: "previewDocxRestrictTrackedChanges" },
	{ edit: "comments", key: "previewDocxRestrictComments" },
	{ edit: "forms", key: "previewDocxRestrictForms" }
]

type ProtectKey =
	"previewDocxRestrictReadOnly" | "previewDocxRestrictTrackedChanges" | "previewDocxRestrictComments" | "previewDocxRestrictForms"

// The Protect group's buttons and their dialogs. `lockTracking`: the group offers Lock Tracking too.
export function DocxProtectButtons({ controls, lockTracking }: { controls: DocxProtectionControls; lockTracking: boolean }) {
	const { t } = useTranslation("preview")
	const [starting, setStarting] = useState<"restrict" | "lock" | null>(null)
	const [pending, setPending] = useState(false)
	const [unprotecting, setUnprotecting] = useState<DocxDocumentProtection | null>(null)
	const protectedNow = controls.mode !== "none"

	const stop = (): void => {
		const found = controls.read()
		const password = found?.password

		if (password === undefined) {
			controls.set(undefined)
		} else if (password === "unsupported") {
			toast.error(t("previewDocxUnprotectUnsupported"))
		} else {
			setUnprotecting(found ?? null)
		}
	}

	const verify = async (value: string, signal: AbortSignal): Promise<PasswordVerdict> => {
		const password = unprotecting?.password

		if (password === undefined || password === "unsupported") {
			return "aborted"
		}

		try {
			const verdict = await verifyProtectionPassword(password, value, { signal })

			if (verdict === "unsupported") {
				toast.error(t("previewDocxUnprotectUnsupported"))
				setUnprotecting(null)

				return "aborted"
			}

			if (verdict === "wrong") {
				return "wrong"
			}

			controls.set(undefined)
			setUnprotecting(null)

			return "accepted"
		} catch {
			// Cancelled.
			return "aborted"
		}
	}

	const start = (request: StartRequest): void => {
		setPending(true)

		const hashed = request.password === "" ? Promise.resolve(undefined) : hashDocumentProtectionPassword(request.password)

		hashed
			.then(hash => {
				controls.set({ edit: request.edit, formatting: request.formatting, ...(hash === undefined ? {} : { password: hash }) })
				setStarting(null)
			})
			.catch((error: unknown) => {
				log.error("docx", "protecting failed", { error })
				toast.error(t("previewDocxProtectFailed"))
			})
			.finally(() => {
				setPending(false)
			})
	}

	const tracking = controls.mode === "trackedChanges"

	return (
		<>
			<RibbonButton
				label={t(protectedNow ? "previewDocxStopProtection" : "previewDocxRestrictEditing")}
				icon={<LockIcon />}
				text={t(protectedNow ? "previewDocxStopProtection" : "previewDocxRestrictEditing")}
				pressed={protectedNow}
				disabled={!protectedNow && !controls.canStart}
				onClick={() => {
					if (protectedNow) {
						stop()
					} else {
						setStarting("restrict")
					}
				}}
			/>
			{lockTracking ? (
				<RibbonButton
					label={t(tracking ? "previewDocxUnlockTracking" : "previewDocxLockTracking")}
					icon={<FileLockIcon />}
					text={t(tracking ? "previewDocxUnlockTracking" : "previewDocxLockTracking")}
					pressed={tracking}
					// Another protection is stopped first, as in Word.
					disabled={tracking ? false : protectedNow || !controls.canStart}
					onClick={() => {
						if (tracking) {
							stop()
						} else {
							setStarting("lock")
						}
					}}
				/>
			) : null}
			<DocxProtectDialog
				open={starting !== null}
				lockTracking={starting === "lock"}
				pending={pending}
				onOpenChange={open => {
					if (!open && !pending) {
						setStarting(null)
					}
				}}
				onStart={start}
			/>
			<DocxPasswordPrompt
				open={unprotecting !== null}
				title={t("previewDocxUnprotectTitle")}
				body={t("previewDocxUnprotectBody")}
				wrongMessage={t("previewDocxUnprotectWrong")}
				label={t("previewDocxUnprotectPassword")}
				submitLabel={t("previewDocxUnprotectAction")}
				progressLabel={t("previewDocxUnprotectChecking")}
				verify={verify}
				onOpenChange={open => {
					if (!open) {
						setUnprotecting(null)
					}
				}}
			/>
		</>
	)
}

interface StartRequest {
	readonly edit: DocxProtectionEdit
	readonly formatting: boolean
	// "" for none.
	readonly password: string
}

// Start Enforcing Protection: the editing allowed (fixed to tracked changes for Lock Tracking), formatting limited to
// styles, and an optional password typed twice.
function DocxProtectDialog({
	open,
	lockTracking,
	pending,
	onOpenChange,
	onStart
}: {
	open: boolean
	lockTracking: boolean
	pending: boolean
	onOpenChange: (open: boolean) => void
	onStart: (request: StartRequest) => void
}) {
	const { t } = useTranslation(["preview", "common"])
	const [edit, setEdit] = useState<DocxProtectionEdit>("readOnly")
	const [formatting, setFormatting] = useState(false)
	const [password, setPassword] = useState("")
	const [confirm, setConfirm] = useState("")
	const [wasOpen, setWasOpen] = useState(open)
	const mismatch = password !== confirm

	// Each opening starts blank.
	if (open !== wasOpen) {
		setWasOpen(open)

		if (open) {
			setEdit("readOnly")
			setFormatting(false)
			setPassword("")
			setConfirm("")
		}
	}

	return (
		<FormDialog
			open={open}
			pending={pending}
			title={t(lockTracking ? "previewDocxLockTrackingTitle" : "previewDocxRestrictTitle")}
			description={t(lockTracking ? "previewDocxLockTrackingBody" : "previewDocxRestrictBody")}
			submitLabel={t(lockTracking ? "previewDocxLockTrackingAction" : "previewDocxRestrictAction")}
			cancelLabel={t("common:cancel")}
			canSubmit={!mismatch}
			onOpenChange={onOpenChange}
			onSubmit={event => {
				event.preventDefault()

				if (mismatch || pending) {
					return
				}

				onStart(lockTracking ? { edit: "trackedChanges", formatting: false, password } : { edit, formatting, password })
			}}
		>
			<FieldGroup>
				{lockTracking ? null : (
					<>
						<fieldset className="flex flex-col gap-1.5">
							<legend className="mb-1.5 text-sm font-medium">{t("previewDocxRestrictAllow")}</legend>
							{EDITS.map(item => (
								<label
									key={item.edit}
									className="flex items-center gap-2 text-sm"
								>
									<input
										type="radio"
										name="docx-restrict-edit"
										className="size-4 accent-primary"
										checked={edit === item.edit}
										disabled={pending}
										onChange={() => {
											setEdit(item.edit)
										}}
									/>
									{t(item.key)}
								</label>
							))}
						</fieldset>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								className="size-4 accent-primary"
								checked={formatting}
								disabled={pending}
								onChange={event => {
									setFormatting(event.target.checked)
								}}
							/>
							{t("previewDocxRestrictFormatting")}
						</label>
					</>
				)}
				<Field>
					<FieldLabel htmlFor="docx-protect-password">{t("previewDocxProtectPassword")}</FieldLabel>
					<SecretInput
						id="docx-protect-password"
						value={password}
						disabled={pending}
						onChange={event => {
							setPassword(event.target.value)

							// The confirmation is locked without a password: it goes with it.
							if (event.target.value === "") {
								setConfirm("")
							}
						}}
					/>
				</Field>
				<Field data-invalid={mismatch && confirm !== "" ? true : undefined}>
					<FieldLabel htmlFor="docx-protect-confirm">{t("previewDocxProtectConfirm")}</FieldLabel>
					<SecretInput
						id="docx-protect-confirm"
						value={confirm}
						disabled={pending || password === ""}
						aria-invalid={mismatch && confirm !== ""}
						onChange={event => {
							setConfirm(event.target.value)
						}}
					/>
					{mismatch && confirm !== "" ? <FieldError>{t("previewDocxProtectMismatch")}</FieldError> : null}
				</Field>
			</FieldGroup>
		</FormDialog>
	)
}
