import type { ActionDef } from "@/lib/keymap/registry"

// A shared link's page. Download is Mod+S (drive's "save to disk"), Save to Cloud Drive Mod+Shift+S. Escape returns
// from a file opened inside a shared directory, Alt+↑ goes up a level, and / focuses the directory's filter (Gmail's
// and GitHub's search key).
export const PUBLIC_LINKS_ACTIONS: readonly ActionDef[] = [
	{ id: "links.download", defaultCombo: "mod+s", scope: "publicLinks", descriptionKey: "publicLinks:linkCommandDownload" },
	{ id: "links.saveToDrive", defaultCombo: "mod+shift+s", scope: "publicLinks", descriptionKey: "publicLinks:linkCommandSaveToDrive" },
	{ id: "links.back", defaultCombo: "escape", scope: "publicLinks", descriptionKey: "publicLinks:linkCommandBack" },
	{ id: "links.up", defaultCombo: "alt+arrowup", scope: "publicLinks", descriptionKey: "publicLinks:linkCommandUp" },
	{ id: "links.filter", defaultCombo: "slash", scope: "publicLinks", descriptionKey: "publicLinks:linkCommandFilter" }
]
