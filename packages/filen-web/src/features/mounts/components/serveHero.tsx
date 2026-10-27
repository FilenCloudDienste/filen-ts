import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { CopyIcon } from "lucide-react"
import type { DesktopServeProtocol } from "@filen/shared/desktop"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { CARD_SURFACE_CLASS } from "@/components/ui/surface"
import { copyText } from "@/lib/copyText"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { PROTOCOL_LABEL_KEY } from "@/features/mounts/lib/mountsRoles"
import { mountsErrorLabel } from "@/features/mounts/lib/mountsActions"
import { PROTOCOL_ICON } from "@/features/mounts/lib/mountsIcons"
import { CONNECT_HINT_KEY, ROLE_STATE_TONE, roleStateKey, serveHostPort } from "@/features/mounts/lib/mountsStatus.logic"
import { useServeControls, type ServeControls } from "@/features/mounts/hooks/useServeControls"
import { RoleHero } from "@/features/mounts/components/roleHero"
import { RoleStatusDot } from "@/features/mounts/components/roleStatus"
import { CredentialRows } from "@/features/mounts/components/serveCredentials"
import type { ServeCredentialsState } from "@/features/mounts/hooks/useServeCredentials"

// A server's on/off switch, wherever it shows: always useServeControls' path.
export function ServeSwitch({ controls }: { controls: ServeControls }) {
	const { t } = useTranslation("mounts")
	const { serve, busy, available, setEnabled } = controls

	return (
		<Switch
			checked={serve.enabled}
			disabled={busy || (!available && !serve.enabled)}
			aria-label={t("serveEnableNamed", { protocol: t(PROTOCOL_LABEL_KEY[serve.protocol]) })}
			onCheckedChange={setEnabled}
		/>
	)
}

// A server's page opens with what a client needs: its state and switch, how to connect, the address with copy, and the
// credentials with show and copy (none for nfs).
export function ServeHero({ controls, credentials }: { controls: ServeControls; credentials: ServeCredentialsState | null }) {
	const { t } = useTranslation("mounts")
	const { serve } = controls
	const url = serve.url

	return (
		<RoleHero
			role={serve.protocol}
			state={serve.state}
			title={t(roleStateKey(serve.protocol, serve.state))}
			status={<span className="line-clamp-2">{t(CONNECT_HINT_KEY[serve.protocol])}</span>}
			control={<ServeSwitch controls={controls} />}
		>
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
						<CopyIcon data-icon="inline-start" />
						{t("copy")}
					</Button>
				)}
			</SettingsRow>
			{credentials === null ? null : <CredentialRows credentials={credentials} />}
		</RoleHero>
	)
}

// One server in the overview grid: its icon, name (opening its page) and switch, then where it listens with copy while
// it runs, else its state.
export function ServeTile({ protocol }: { protocol: DesktopServeProtocol }) {
	const { t } = useTranslation("mounts")
	const controls = useServeControls(protocol)

	if (controls === null) {
		return null
	}

	const { serve } = controls
	const Icon = PROTOCOL_ICON[protocol]
	const name = t(PROTOCOL_LABEL_KEY[protocol])
	const url = serve.url
	const running = ROLE_STATE_TONE[serve.state] === "on"

	return (
		<article className={cn(CARD_SURFACE_CLASS, "relative flex flex-col gap-4 p-4 transition-colors hover:bg-muted/30")}>
			<div className="flex items-center gap-3">
				<span
					className={cn(
						"flex size-9 shrink-0 items-center justify-center rounded-xl",
						running ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"
					)}
				>
					<Icon
						aria-hidden="true"
						className="size-4.5"
					/>
				</span>
				<Link
					to="/mounts/$role"
					params={{ role: protocol }}
					className="min-w-0 flex-1 truncate rounded-md font-medium focus-ring outline-none after:absolute after:inset-0"
				>
					{t("serveTitle", { protocol: name })}
				</Link>
				<ServeSwitch controls={controls} />
			</div>
			<div className="flex min-h-8 items-center gap-2 text-sm">
				<RoleStatusDot state={serve.state} />
				{running && url !== null ? (
					<>
						<span
							title={url}
							className="min-w-0 flex-1 truncate font-mono text-[13px]"
						>
							{serveHostPort(serve)}
						</span>
						<TooltipIconButton
							label={t("serveUrlCopy")}
							className="relative"
							onClick={() => {
								void copyText(url, t("serveUrlCopied"))
							}}
						>
							<CopyIcon />
						</TooltipIconButton>
					</>
				) : (
					<span
						title={serve.error === null ? undefined : mountsErrorLabel(serve.error)}
						className={cn("min-w-0 flex-1 truncate", serve.state === "error" ? "text-destructive" : "text-muted-foreground")}
					>
						{t(roleStateKey(protocol, serve.state))}
					</span>
				)}
			</div>
			{controls.dialogs}
		</article>
	)
}
