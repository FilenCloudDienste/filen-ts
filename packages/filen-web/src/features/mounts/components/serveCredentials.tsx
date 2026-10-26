import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { DesktopCredentialProtocol, DesktopServeCredentials } from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SecretInput } from "@/components/ui/secretInput"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { FormDialog } from "@/components/dialogs/formDialog"
import { SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import { mountsApi } from "@/features/mounts/lib/mountsStore"
import { callMounts, mountsErrorLabel, runMountsAction } from "@/features/mounts/lib/mountsActions"
import { credentialLabels } from "@/features/mounts/lib/mountsStatus.logic"

const MASK = "••••••••••••"

// Typed credentials: a user and password, or an s3 key pair.
function credentialsOf(protocol: DesktopCredentialProtocol, user: string, secret: string): DesktopServeCredentials {
	return protocol === "s3" ? { kind: "s3", accessKeyId: user, secretAccessKey: secret } : { kind: "basic", user, password: secret }
}

function partsOf(credentials: DesktopServeCredentials): { user: string; secret: string } {
	return credentials.kind === "s3"
		? { user: credentials.accessKeyId, secret: credentials.secretAccessKey }
		: { user: credentials.user, secret: credentials.password }
}

// The user's own credentials. The shell judges them; a weak or unusable pair is told under the fields.
function CustomCredentialsDialog({
	protocol,
	onSaved,
	onClose
}: {
	protocol: DesktopCredentialProtocol
	onSaved: () => void
	onClose: () => void
}) {
	const { t } = useTranslation(["mounts", "common"])
	const id = useId()
	const labels = credentialLabels(protocol)
	const [user, setUser] = useState("")
	const [secret, setSecret] = useState("")
	const [pending, setPending] = useState(false)
	const [refusal, setRefusal] = useState<string | null>(null)
	const canSubmit = user.trim().length > 0 && secret.length > 0

	async function save(): Promise<void> {
		setPending(true)
		setRefusal(null)

		const result = await callMounts(() => mountsApi().setCredentials(protocol, credentialsOf(protocol, user.trim(), secret)))

		setPending(false)

		if (result.ok) {
			toast.success(t("credentialsSaved"))
			onSaved()
			onClose()
		} else if (result.error.code === "credentialsWeak" || result.error.code === "credentialsInvalid") {
			setRefusal(mountsErrorLabel(result.error))
		} else {
			toast.error(mountsErrorLabel(result.error))
		}
	}

	return (
		<FormDialog
			open
			pending={pending}
			title={t("credentialsCustomTitle")}
			description={t(protocol === "s3" ? "credentialsCustomDescriptionS3" : "credentialsCustomDescription")}
			submitLabel={t("credentialsCustomSave")}
			cancelLabel={t("common:cancel")}
			canSubmit={canSubmit}
			onOpenChange={next => {
				if (!next) {
					onClose()
				}
			}}
			onSubmit={event => {
				event.preventDefault()

				if (canSubmit) {
					void save()
				}
			}}
		>
			<FieldGroup>
				<Field>
					<FieldLabel htmlFor={`${id}-user`}>{t(labels.user)}</FieldLabel>
					<Input
						id={`${id}-user`}
						autoComplete="off"
						spellCheck={false}
						className="leading-5"
						value={user}
						disabled={pending}
						onChange={event => {
							setUser(event.target.value)
							setRefusal(null)
						}}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${id}-secret`}>{t(labels.secret)}</FieldLabel>
					<SecretInput
						id={`${id}-secret`}
						className="leading-5"
						value={secret}
						disabled={pending}
						aria-invalid={refusal !== null}
						aria-describedby={`${id}-secret-hint`}
						onChange={event => {
							setSecret(event.target.value)
							setRefusal(null)
						}}
					/>
					{refusal === null ? (
						<FieldDescription id={`${id}-secret-hint`}>{t("credentialsCustomHint")}</FieldDescription>
					) : (
						<FieldError id={`${id}-secret-hint`}>{refusal}</FieldError>
					)}
				</Field>
			</FieldGroup>
		</FormDialog>
	)
}

// One credential part: hidden until revealed, copied by the shell straight to the clipboard.
function CredentialRow({
	protocol,
	part,
	label,
	value
}: {
	protocol: DesktopCredentialProtocol
	part: "user" | "secret"
	label: string
	value: string | null
}) {
	const { t } = useTranslation("mounts")

	return (
		<SettingsRow
			label={label}
			description={<span className="font-mono break-all">{value ?? MASK}</span>}
		>
			<Button
				variant="outline"
				aria-label={t("credentialCopy", { label })}
				onClick={() => {
					void runMountsAction(() => mountsApi().copyCredential(protocol, part)).then(done => {
						if (done !== null) {
							toast.success(t("credentialCopied", { label }))
						}
					})
				}}
			>
				{t("copy")}
			</Button>
		</SettingsRow>
	)
}

// A server's credentials: made at random by the shell, shown on request (and forgotten with this page), copied,
// made anew, or set by the user.
export function ServeCredentials({ protocol }: { protocol: DesktopCredentialProtocol }) {
	const { t } = useTranslation(["mounts", "common"])
	const labels = credentialLabels(protocol)
	const [revealed, setRevealed] = useState<{ user: string; secret: string } | null>(null)
	const [revealing, setRevealing] = useState(false)
	const [dialog, setDialog] = useState<"regenerate" | "custom" | null>(null)
	const [regenerating, setRegenerating] = useState(false)

	async function reveal(): Promise<void> {
		setRevealing(true)

		const done = await runMountsAction(() => mountsApi().credentials(protocol))

		setRevealing(false)
		setRevealed(done === null ? null : partsOf(done.value))
	}

	// Shown ones are read again so the page never shows credentials that no longer work.
	function changed(): void {
		if (revealed !== null) {
			void reveal()
		}
	}

	async function regenerate(): Promise<void> {
		setRegenerating(true)

		const done = await runMountsAction(() => mountsApi().regenerateCredentials(protocol))

		setRegenerating(false)

		if (done !== null) {
			setDialog(null)
			toast.success(t("credentialsRegeneratedToast"))
			changed()
		}
	}

	return (
		<SettingsGroup
			title={t("serveGroupCredentials")}
			description={t("serveCredentialsDescription")}
		>
			<CredentialRow
				protocol={protocol}
				part="user"
				label={t(labels.user)}
				value={revealed?.user ?? null}
			/>
			<CredentialRow
				protocol={protocol}
				part="secret"
				label={t(labels.secret)}
				value={revealed?.secret ?? null}
			/>
			<SettingsRow
				label={t("credentialsReveal")}
				description={t("credentialsRevealDescription")}
			>
				<Button
					variant="outline"
					aria-label={revealed === null ? t("credentialsReveal") : t("credentialsHide")}
					disabled={revealing}
					onClick={() => {
						if (revealed === null) {
							void reveal()
						} else {
							setRevealed(null)
						}
					}}
				>
					{revealed === null ? t("credentialsRevealAction") : t("credentialsHideAction")}
				</Button>
			</SettingsRow>
			<SettingsRow
				label={t("credentialsRegenerate")}
				description={t("credentialsRegenerateDescription")}
			>
				<Button
					variant="outline"
					aria-label={t("credentialsRegenerate")}
					onClick={() => {
						setDialog("regenerate")
					}}
				>
					{t("credentialsRegenerateAction")}
				</Button>
			</SettingsRow>
			<SettingsRow
				label={t("credentialsCustom")}
				description={t("credentialsCustomRowDescription")}
			>
				<Button
					variant="outline"
					aria-label={t("credentialsCustom")}
					onClick={() => {
						setDialog("custom")
					}}
				>
					{t("credentialsCustomAction")}
				</Button>
			</SettingsRow>
			<ConfirmDialog
				open={dialog === "regenerate"}
				pending={regenerating}
				title={t("credentialsRegenerateTitle")}
				body={t("credentialsRegenerateBody")}
				confirmLabel={t("credentialsRegenerateAction")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={next => {
					if (!next) {
						setDialog(null)
					}
				}}
				onConfirm={() => {
					void regenerate()
				}}
			/>
			{dialog === "custom" ? (
				<CustomCredentialsDialog
					protocol={protocol}
					onSaved={changed}
					onClose={() => {
						setDialog(null)
					}}
				/>
			) : null}
		</SettingsGroup>
	)
}
