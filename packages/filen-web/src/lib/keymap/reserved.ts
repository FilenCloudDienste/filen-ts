import { chordIdentity, parseCombo, type Chord } from "@filen/shared/keymap"
import type { KeymapPlatform } from "@/lib/keymap/registry"

// Who keeps a keystroke before (or instead of) the page: every browser, Firefox, the operating system, or the desktop
// app's own menu. A web page can only warn (the browser may still hand it the key); the desktop app knows its shell
// and refuses the system's and its menu's keys outright.
export type ReservedOwner = "browser" | "firefox" | "system" | "appMenu"

interface ReservedTable {
	readonly owner: ReservedOwner
	readonly on: Partial<KeymapPlatform>
	readonly combos: readonly string[]
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]

const TABLES: readonly ReservedTable[] = [
	// Tabs and windows, which Chromium never hands a page, plus the address bar and history navigation.
	{
		owner: "browser",
		on: { desktop: false },
		combos: [
			"mod+w",
			"mod+t",
			"mod+n",
			"mod+shift+n",
			"mod+shift+t",
			"mod+shift+w",
			"ctrl+tab",
			"ctrl+shift+tab",
			"mod+l",
			...DIGITS.map(digit => `mod+${digit}`)
		]
	},
	{
		owner: "browser",
		on: { desktop: false, mac: false },
		combos: ["alt+arrowleft", "alt+arrowright", "alt+home", "ctrl+pageup", "ctrl+pagedown"]
	},
	{
		owner: "browser",
		on: { desktop: false, mac: true },
		combos: ["mod+comma", "mod+bracketleft", "mod+bracketright", "mod+alt+arrowleft", "mod+alt+arrowright"]
	},
	// Firefox: private window, web console, downloads search, responsive design mode.
	{ owner: "firefox", on: { desktop: false }, combos: ["mod+shift+p", "mod+shift+k", "mod+shift+e", "mod+shift+m"] },
	// macOS: quit, hide, minimize, Spotlight, the input source switch, the app switcher, screenshots, force quit,
	// Mission Control and Spaces, and the Help menu's search.
	{
		owner: "system",
		on: { mac: true },
		combos: [
			"mod+q",
			"mod+h",
			"mod+alt+h",
			"mod+m",
			"mod+space",
			"ctrl+space",
			"mod+tab",
			"mod+shift+tab",
			"mod+backquote",
			"mod+shift+3",
			"mod+shift+4",
			"mod+shift+5",
			"mod+alt+escape",
			"ctrl+arrowup",
			"ctrl+arrowdown",
			"ctrl+arrowleft",
			"ctrl+arrowright",
			"ctrl+f1",
			"mod+shift+slash"
		]
	},
	// Windows and Linux desktops: window switching, the window menu, closing a window, the secure attention sequence.
	{
		owner: "system",
		on: { mac: false },
		combos: ["alt+tab", "alt+shift+tab", "alt+f4", "alt+space", "ctrl+alt+delete", "ctrl+shift+escape"]
	},
	// The macOS desktop app's window menu roles.
	{ owner: "appMenu", on: { mac: true, desktop: true }, combos: ["mod+w", "mod+ctrl+f"] }
]

function applies(table: ReservedTable, platform: KeymapPlatform): boolean {
	return (
		(table.on.mac === undefined || table.on.mac === platform.mac) &&
		(table.on.desktop === undefined || table.on.desktop === platform.desktop)
	)
}

// The tables as keystroke identities per platform, built on first use.
const byPlatform = new Map<string, ReadonlyMap<string, ReservedOwner>>()

function reservedOn(platform: KeymapPlatform): ReadonlyMap<string, ReservedOwner> {
	const id = `${String(platform.mac)}:${String(platform.desktop)}`
	let table = byPlatform.get(id)

	if (table === undefined) {
		const built = new Map<string, ReservedOwner>()

		for (const entry of TABLES) {
			if (!applies(entry, platform)) {
				continue
			}

			for (const combo of entry.combos) {
				for (const chord of parseCombo(combo)) {
					const identity = chordIdentity(chord, platform.mac)

					if (!built.has(identity)) {
						built.set(identity, entry.owner)
					}
				}
			}
		}

		table = built
		byPlatform.set(id, table)
	}

	return table
}

// Who keeps a chord on a platform. Any Windows (Super) key chord off a Mac is the system's: Windows and the Linux
// desktops take most of them.
export function reservedOwner(chord: Chord, platform: KeymapPlatform): ReservedOwner | undefined {
	if (!platform.mac && chord.meta) {
		return "system"
	}

	return reservedOn(platform).get(chordIdentity(chord, platform.mac))
}

// Whether saving the chord is refused rather than warned about: only the desktop app knows what its shell takes.
export function reservedBlocks(owner: ReservedOwner, platform: KeymapPlatform): boolean {
	return platform.desktop && (owner === "system" || owner === "appMenu")
}
