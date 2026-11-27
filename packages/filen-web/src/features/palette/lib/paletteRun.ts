import type { useRouter } from "@tanstack/react-router"
import { runLiveAction } from "@/lib/keymap/liveActions"
import { requestSettingsHighlight } from "@/lib/settingsHighlight"
import { settingsSectionOf } from "@/features/settings/lib/settingsSections"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { withRecent, type PaletteTarget } from "@/features/palette/lib/palette.logic"

type Router = ReturnType<typeof useRouter>

// The rows picked lately in this tab, latest first, by key.
let recent: string[] = []

export function paletteRecent(): readonly string[] {
	return recent
}

export function rememberPaletteRow(key: string): void {
	recent = withRecent(recent, key)
}

export function resetPaletteRecent(): void {
	recent = []
}

// Runs a picked row once the palette has closed, so an action's own dialog guard sees the page as the key would.
// `focus` is where focus was when the palette opened.
export function runPaletteTarget(target: PaletteTarget, router: Router, focus: Element | null): void {
	switch (target.kind) {
		case "action":
			runLiveAction(target.id, focus)
			break
		case "settingsSection":
			void router.navigate({ to: target.to })
			break
		case "setting": {
			const section = settingsSectionOf(target.entry)

			if (section !== undefined) {
				requestSettingsHighlight(target.entry.id)
				void router.navigate({ to: section.to })
			}

			break
		}
		case "directory":
			void router.navigate({ to: "/drive/$", params: { _splat: target.splat } })
			break
		case "file":
			// The destination listing selects, scrolls to and focuses the row (useDriveListboxNav).
			useDriveStore.getState().requestReveal({ uuid: target.uuid, splat: target.splat })
			void router.navigate({ to: "/drive/$", params: { _splat: target.splat } })
			break
		case "note":
			void router.navigate({ to: "/notes/$uuid", params: { uuid: target.uuid } })
			break
		case "chat":
			void router.navigate({ to: "/chats/$uuid", params: { uuid: target.uuid } })
			break
		case "driveSearch":
			useDriveStore.getState().requestSearch({ splat: "", query: target.query })
			void router.navigate({ to: "/drive/$", params: { _splat: "" } })
			break
	}
}
