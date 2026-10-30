import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { ExternalLinkIcon } from "lucide-react"
import { useShallow } from "zustand/shallow"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { ActionRow } from "@/features/desktop/components/actionRow"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"
import {
	fileProviderErrorLabel,
	openFileProviderSettings,
	revealFileProvider,
	setFileProviderEnabled,
	useFileProviderStatus,
	useFileProviderStore
} from "@/features/mounts/lib/fileProviderStore"
import {
	FILE_PROVIDER_CALLOUT_KEY,
	FILE_PROVIDER_CALLOUT_TONE,
	FILE_PROVIDER_STATUS_KEY,
	FILE_PROVIDER_STATUS_TONE,
	fileProviderCallouts
} from "@/features/mounts/lib/fileProviderStatus.logic"
import { FINDER_ROLE } from "@/features/mounts/lib/mountsRoles"
import { RoleHero } from "@/features/mounts/components/roleHero"
import { RoleStatusDot } from "@/features/mounts/components/roleStatus"

// Filen in Finder at a glance: its state and switch, and Open in Finder while it shows there. In the overview its title
// links to its page; on the page the title is its state, over what it does.
export function FinderHero({ overview }: { overview: boolean }) {
	const { t } = useTranslation("mounts")
	const { status, enabled, locked } = useFileProviderStatus()
	const tone = FILE_PROVIDER_STATUS_TONE[status]
	const statusLabel = t(FILE_PROVIDER_STATUS_KEY[status])

	return (
		<RoleHero
			role={FINDER_ROLE}
			tone={tone}
			title={
				overview ? (
					<Link
						to="/mounts/$role"
						params={{ role: FINDER_ROLE }}
						className="rounded-md focus-ring outline-none hover:underline hover:underline-offset-4"
					>
						{t("mountsFinder")}
					</Link>
				) : (
					statusLabel
				)
			}
			status={
				overview ? (
					<>
						<RoleStatusDot tone={tone} />
						<span className="truncate">{statusLabel}</span>
					</>
				) : (
					<span className="line-clamp-2">{t("finderDescription")}</span>
				)
			}
			control={
				<Switch
					checked={enabled}
					disabled={locked}
					aria-label={t("finderEnable")}
					onCheckedChange={next => {
						void setFileProviderEnabled(next)
					}}
				/>
			}
		>
			<ActionRow
				label={t("finderOpen")}
				description={t("finderOpenDescription")}
				action={t("finderOpenAction")}
				disabled={status !== "on"}
				icon={<ExternalLinkIcon data-icon="inline-start" />}
				run={revealFileProvider}
			/>
		</RoleHero>
	)
}

// Why Filen in Finder is off or not showing, and what to do: move the app, the app lock, the System Settings switch,
// a failed registration, or the last failure.
export function FinderCallouts() {
	const { t } = useTranslation("mounts")
	const callouts = useFileProviderStore(
		useShallow(({ state, pending, failure }) => fileProviderCallouts(state, pending, failure?.code ?? null))
	)
	const error = useFileProviderStore(state => state.failure?.code ?? null)

	return callouts.map(callout => (
		<DesktopCallout
			key={callout}
			tone={FILE_PROVIDER_CALLOUT_TONE[callout]}
			action={
				callout === "needsEnabling" ? (
					<Button
						variant="outline"
						size="xs"
						onClick={openFileProviderSettings}
					>
						{t("finderOpenSettings")}
					</Button>
				) : undefined
			}
		>
			{callout === "error" ? fileProviderErrorLabel(error ?? "unknown") : t(FILE_PROVIDER_CALLOUT_KEY[callout])}
		</DesktopCallout>
	))
}
