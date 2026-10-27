import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { type } from "arktype"
import type { DesktopListenAddress, DesktopServe, DesktopServePatch, DesktopServeProtocol } from "@filen/shared/desktop"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { LoadingState } from "@/components/loadingState"
import { log } from "@/lib/log"
import { SettingsGroup, SettingsRow } from "@/features/settings/components/settingsLayout"
import { PreferenceToggleRow, SettingsSelectRow } from "@/features/settings/components/settingRows"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import { mountsApi } from "@/features/mounts/lib/mountsStore"
import { PROTOCOL_LABEL_KEY } from "@/features/mounts/lib/mountsRoles"
import { ADDRESS_KIND_KEY, addressChoices, portInput, sendsPlainText } from "@/features/mounts/lib/mountsStatus.logic"
import { useServeControls } from "@/features/mounts/hooks/useServeControls"
import { HeroSection, MountsNoticeBanner, MountsPage, RoleErrorCallout } from "@/features/mounts/components/mountsPage"
import { ServeCredentials } from "@/features/mounts/components/serveCredentials"
import { useServeCredentials } from "@/features/mounts/hooks/useServeCredentials"
import { ServeHero } from "@/features/mounts/components/serveHero"

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

// One protocol's server: a hero with its switch, how to connect, address and credentials, then where it listens,
// https, read-only and replacing its credentials.
export function ServePage({ protocol }: { protocol: DesktopServeProtocol }) {
	const { t } = useTranslation("mounts")
	const controls = useServeControls(protocol)
	const credentials = useServeCredentials(protocol)

	if (controls === null) {
		return <LoadingState size="lg" />
	}

	const { serve, available, busy, update, setHttps } = controls
	const name = t(PROTOCOL_LABEL_KEY[protocol])

	return (
		<MountsPage
			role={protocol}
			title={t("serveTitle", { protocol: name })}
		>
			<HeroSection>
				<ServeHero
					controls={controls}
					credentials={credentials}
				/>
				{available ? null : <DesktopCallout tone="error">{t("unavailable")}</DesktopCallout>}
				<MountsNoticeBanner scope="serve" />
				<RoleErrorCallout error={serve.error} />
				{sendsPlainText(serve) ? <DesktopCallout tone="warning">{t("servePlainText")}</DesktopCallout> : null}
				{serve.authenticated ? null : <DesktopCallout tone="info">{t("serveUnauthenticated", { protocol: name })}</DesktopCallout>}
			</HeroSection>
			<SettingsGroup title={t("serveGroupServer")}>
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
						onCheckedChange={setHttps}
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
			{credentials === null ? null : <ServeCredentials credentials={credentials} />}
			{controls.dialogs}
		</MountsPage>
	)
}
