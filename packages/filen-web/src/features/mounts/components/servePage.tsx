import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { type } from "arktype"
import type { DesktopListenAddress, DesktopServe, DesktopServePatch, DesktopServeProtocol } from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { LoadingState } from "@/components/loadingState"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { copyText } from "@/lib/copyText"
import { log } from "@/lib/log"
import { SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import { PreferenceToggleRow, SettingsSelectRow } from "@/features/settings/components/settingRows"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import { mountsApi, useMountsServe, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { runMountsAction } from "@/features/mounts/lib/mountsActions"
import { PROTOCOL_LABEL_KEY } from "@/features/mounts/lib/mountsRoles"
import {
	ADDRESS_KIND_KEY,
	addressChoices,
	CONNECT_HINT_KEY,
	enableNeedsAcknowledgement,
	httpsOffNeedsWarning,
	portInput,
	roleBusy,
	sendsPlainText
} from "@/features/mounts/lib/mountsStatus.logic"
import { MountsNoticeBanner, MountsPage, RoleErrorCallout } from "@/features/mounts/components/mountsPage"
import { ServeCredentials } from "@/features/mounts/components/serveCredentials"
import { UnauthenticatedDialog } from "@/features/mounts/components/unauthenticatedDialog"

// The addresses this device can listen on, read once per visit; null while in flight.
function useListenAddresses(): DesktopListenAddress[] | null {
	const [addresses, setAddresses] = useState<DesktopListenAddress[] | null>(null)

	useEffect(() => {
		let live = true

		mountsApi()
			.listenAddresses()
			.then(
				next => {
					if (live) {
						setAddresses(next)
					}
				},
				(error: unknown) => {
					log.warn("mounts", "listen addresses could not be read", error)

					if (live) {
						setAddresses([])
					}
				}
			)

		return () => {
			live = false
		}
	}, [])

	return addresses
}

function AddressRow({
	serve,
	disabled,
	onChange
}: {
	serve: DesktopServe
	disabled: boolean
	onChange: (patch: DesktopServePatch) => void
}) {
	const { t } = useTranslation("mounts")
	const id = useId()
	const addresses = useListenAddresses()
	const choices = addresses === null ? null : addressChoices(serve.protocol, addresses)

	function label(address: DesktopListenAddress): string {
		return t(ADDRESS_KIND_KEY[address.kind], { address: address.address, interface: address.interface ?? "" })
	}

	const options =
		choices === null
			? []
			: choices.some(choice => choice.address === serve.address)
				? choices.map(choice => ({ value: choice.address, label: label(choice) }))
				: [
						{ value: serve.address, label: t("addressGone", { address: serve.address }) },
						...choices.map(choice => ({ value: choice.address, label: label(choice) }))
					]

	return (
		<SettingsSelectRow
			id={id}
			label={t("serveAddress")}
			description={serve.protocol === "nfs" ? t("serveAddressNfs") : t("serveAddressDescription")}
			options={options}
			value={choices === null ? undefined : serve.address}
			disabled={disabled}
			onChange={address => {
				if (address !== serve.address) {
					onChange({ address })
				}
			}}
		/>
	)
}

// Remounted (keyed by the port) when the port changes elsewhere.
function PortRow({ port, disabled, onSave }: { port: number; disabled: boolean; onSave: (port: number) => Promise<unknown> }) {
	const { t } = useTranslation("mounts")
	const id = useId()
	const [draft, setDraft] = useState(String(port))
	const [saving, setSaving] = useState(false)
	const parsed = portInput(draft.trim())
	const invalid = parsed instanceof type.errors
	const canSave = !saving && !disabled && !invalid && parsed !== port

	return (
		<SettingsRow
			label={t("servePort")}
			description={invalid ? <span className="text-destructive">{t("servePortInvalid")}</span> : undefined}
			htmlFor={id}
		>
			<form
				className="flex items-center gap-2"
				onSubmit={event => {
					event.preventDefault()

					if (canSave) {
						setSaving(true)
						void onSave(parsed).finally(() => {
							setSaving(false)
						})
					}
				}}
			>
				<Input
					id={id}
					inputMode="numeric"
					value={draft}
					disabled={saving || disabled}
					aria-invalid={invalid}
					className="w-28 leading-5"
					onChange={event => {
						setDraft(event.target.value)
					}}
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={!canSave}
				>
					{saving ? <Spinner data-icon="inline-start" /> : null}
					{t("servePortSave")}
				</Button>
			</form>
		</SettingsRow>
	)
}

// What a client connects to, and what else it needs to know.
function ConnectGroup({ serve }: { serve: DesktopServe }) {
	const { t } = useTranslation("mounts")
	const url = serve.url

	return (
		<SettingsGroup title={t("serveGroupConnect")}>
			<SettingsRow
				label={t("serveUrl")}
				description={url === null ? t("serveUrlOff") : <span className="font-mono break-all">{url}</span>}
			>
				{url === null ? undefined : (
					<Button
						variant="outline"
						aria-label={t("serveUrlCopy")}
						onClick={() => {
							void copyText(url, t("serveUrlCopied"))
						}}
					>
						{t("copy")}
					</Button>
				)}
			</SettingsRow>
			<SettingsRow
				label={t("serveHowTo")}
				description={t(CONNECT_HINT_KEY[serve.protocol])}
			/>
		</SettingsGroup>
	)
}

// One protocol's server: running it, where it listens, https, read-only, how to connect and its credentials.
export function ServePage({ protocol }: { protocol: DesktopServeProtocol }) {
	const { t } = useTranslation(["mounts", "common"])
	const serve = useMountsServe(protocol)
	const available = useMountsStore(state => state.overview?.available ?? true)
	const [pending, setPending] = useState(false)
	const [dialog, setDialog] = useState<"acknowledge" | "httpsOff" | null>(null)

	if (serve === null) {
		return <LoadingState size="lg" />
	}

	const name = t(PROTOCOL_LABEL_KEY[protocol])
	const busy = pending || roleBusy(serve.state)

	async function update(patch: DesktopServePatch): Promise<boolean> {
		setPending(true)

		const done = await runMountsAction(() => mountsApi().setServe(protocol, patch))

		setPending(false)

		return done !== null
	}

	return (
		<MountsPage
			role={protocol}
			title={t("serveTitle", { protocol: name })}
			state={serve.state}
		>
			{available ? null : <DesktopCallout tone="error">{t("unavailable")}</DesktopCallout>}
			<MountsNoticeBanner scope="serve" />
			<RoleErrorCallout error={serve.error} />
			{sendsPlainText(serve) ? <DesktopCallout tone="warning">{t("servePlainText")}</DesktopCallout> : null}
			{serve.authenticated ? null : <DesktopCallout tone="info">{t("serveUnauthenticated", { protocol: name })}</DesktopCallout>}
			<SettingsGroup title={t("serveGroupServer")}>
				<PreferenceToggleRow
					title={t("serveEnable")}
					description={t("serveEnableDescription", { protocol: name })}
					checked={serve.enabled}
					disabled={busy || (!available && !serve.enabled)}
					onCheckedChange={enabled => {
						if (enabled && enableNeedsAcknowledgement(serve)) {
							setDialog("acknowledge")
						} else {
							void update({ enabled })
						}
					}}
				/>
				<AddressRow
					serve={serve}
					disabled={busy}
					onChange={patch => {
						void update(patch)
					}}
				/>
				<PortRow
					key={serve.port}
					port={serve.port}
					disabled={busy}
					onSave={port => update({ port })}
				/>
				{serve.httpsCapable ? (
					<PreferenceToggleRow
						title={t("serveHttps")}
						description={
							serve.https && serve.tlsFingerprint !== null
								? t("serveHttpsFingerprint", { fingerprint: serve.tlsFingerprint })
								: t("serveHttpsDescription")
						}
						checked={serve.https}
						disabled={busy}
						onCheckedChange={https => {
							if (!https && httpsOffNeedsWarning(serve)) {
								setDialog("httpsOff")
							} else {
								void update({ https })
							}
						}}
					/>
				) : null}
				<PreferenceToggleRow
					title={t("serveReadOnly")}
					description={t("serveReadOnlyDescription")}
					checked={serve.readOnly}
					disabled={busy}
					onCheckedChange={readOnly => {
						void update({ readOnly })
					}}
				/>
			</SettingsGroup>
			<ConnectGroup serve={serve} />
			{serve.protocol === "nfs" ? null : <ServeCredentials protocol={serve.protocol} />}
			{dialog === "acknowledge" ? (
				<UnauthenticatedDialog
					protocol={protocol}
					onClose={() => {
						setDialog(null)
					}}
				/>
			) : null}
			<ConfirmDialog
				open={dialog === "httpsOff"}
				pending={pending}
				title={t("httpsOffTitle")}
				body={t("httpsOffBody", { address: serve.address })}
				confirmLabel={t("httpsOffConfirm")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={next => {
					if (!next) {
						setDialog(null)
					}
				}}
				onConfirm={() => {
					void update({ https: false }).then(() => {
						setDialog(null)
					})
				}}
			/>
		</MountsPage>
	)
}
