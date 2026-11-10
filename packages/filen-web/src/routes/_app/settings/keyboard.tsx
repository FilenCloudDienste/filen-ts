import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { KeyboardIcon } from "lucide-react"
import { ShortcutsList } from "@/lib/keymap/shortcutsList"
import { KeyboardActions } from "@/features/settings/components/keyboard/keyboardActions"
import { SettingsPageHeader } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

export const Route = createFileRoute("/_app/settings/keyboard")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionKeyboard"), i18n.t("common:settings")] }),
	component: KeyboardPage
})

// The settings half of the shortcuts surface. Same <ShortcutsList /> the ? overlay renders — this page adds only the
// export, import and reset-all actions around it. The list is its own scroll area (virtualized), so the page does not
// scroll.
function KeyboardPage() {
	const { t } = useTranslation(["settings", "common"])

	return (
		<>
			<SettingsPageHeader
				icon={KeyboardIcon}
				title={t("settingsSectionKeyboard")}
			/>
			<div className="flex min-h-0 flex-1 flex-col px-4 pt-2 pb-6 sm:px-6">
				<div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4">
					<div className="flex flex-wrap items-start justify-between gap-3 px-1">
						<div className="flex min-w-0 flex-1 basis-64 flex-col gap-1 text-sm text-muted-foreground">
							<p>{t("common:shortcutsDescription")}</p>
							<p className="text-xs">{t("keyboardScopeNote")}</p>
						</div>
						<KeyboardActions />
					</div>
					<ShortcutsList variant="page" />
				</div>
			</div>
		</>
	)
}
