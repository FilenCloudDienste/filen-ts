// KeyTips, as Office's: a key sequence that picks a ribbon tab (level one) and then one of its commands (level two),
// each target badged with its tip while the layer shows. Tips of a level are prefix-free, so typing one is unambiguous.

// Word's, Excel's and PowerPoint's default tab letters. File is F.
const TAB_TIPS: Readonly<Record<string, string>> = {
	home: "H",
	insert: "N",
	layout: "P",
	references: "S",
	review: "R",
	view: "W",
	data: "A",
	design: "G",
	transitions: "K",
	animations: "A",
	slideShow: "S"
}

export const FILE_KEYTIP = "F"

// Contextual tabs take two-letter tips under J (Office's JT, JP, JC), the rest of the generated ones under Y.
const CONTEXTUAL_PREFIX = "J"
const FALLBACK_PREFIX = "Y"
const ALPHANUMERIC = /[\p{L}\p{N}]/u

function characters(label: string): string[] {
	const out: string[] = []

	for (const char of label.toLocaleUpperCase()) {
		if (ALPHANUMERIC.test(char)) out.push(char)
	}

	return out
}

export interface KeyTipTab {
	readonly id: string
	readonly label: string
	readonly contextual?: boolean
}

// The tabs' tips, in their order: the default letter where it is free, else a free letter of the label, else Y and a
// digit; contextual tabs J and a letter of their label.
export function tabKeyTips(tabs: readonly KeyTipTab[]): string[] {
	const used = new Set<string>([FILE_KEYTIP, CONTEXTUAL_PREFIX, FALLBACK_PREFIX])
	const tips: (string | undefined)[] = tabs.map(tab => {
		const tip = tab.contextual === true ? undefined : TAB_TIPS[tab.id]

		if (tip === undefined || used.has(tip)) return undefined

		used.add(tip)

		return tip
	})
	let fallback = 0

	return tabs.map((tab, index) => {
		const known = tips[index]

		if (known !== undefined) return known

		const letters = characters(tab.label)
		const prefix = tab.contextual === true ? CONTEXTUAL_PREFIX : ""
		const tip = (letters.length > 0 ? letters : ["X"]).map(char => prefix + char).find(candidate => !used.has(candidate))

		if (tip !== undefined) {
			used.add(tip)

			return tip
		}

		for (;;) {
			fallback += 1

			const candidate = (prefix === "" ? FALLBACK_PREFIX : prefix) + String(fallback)

			if (!used.has(candidate)) {
				used.add(candidate)

				return candidate
			}
		}
	})
}

// The commands' tips, in their order: the label's first letter where no other command starts with it, else that
// letter and a further one of the label (else a digit), so no tip is the start of another.
export function controlKeyTips(labels: readonly string[]): string[] {
	const firsts = labels.map(label => characters(label)[0] ?? FALLBACK_PREFIX)
	const counts = new Map<string, number>()

	for (const first of firsts) counts.set(first, (counts.get(first) ?? 0) + 1)

	const used = new Set<string>()

	return labels.map((label, index) => {
		const first = firsts[index] ?? FALLBACK_PREFIX

		if (counts.get(first) === 1) {
			used.add(first)

			return first
		}

		const second = characters(label)
			.slice(1)
			.map(char => first + char)
			.find(candidate => !used.has(candidate))
		let tip = second
		let digit = 0

		while (tip === undefined || used.has(tip)) {
			digit += 1
			tip = first + String(digit)
		}

		used.add(tip)

		return tip
	})
}

// What a typed sequence picks among a level's tips: one (exactly typed), more to come (it starts some), or nothing.
export function matchKeyTip(tips: readonly string[], typed: string): number | "prefix" | null {
	const exact = tips.indexOf(typed)

	if (exact !== -1) return exact

	return tips.some(tip => tip.startsWith(typed)) ? "prefix" : null
}

// The characters a key may type into a tip: what it prints, then (for another keyboard layout) its key's letter.
export function keyTipCharacters(event: { readonly key: string; readonly code: string }): string[] {
	const out: string[] = []

	if (/^[\p{L}\p{N}]$/u.test(event.key)) out.push(event.key.toLocaleUpperCase())

	const code = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code)
	const fromCode = code?.[1] ?? code?.[2]

	if (fromCode !== undefined && !out.includes(fromCode)) out.push(fromCode)

	return out
}

export interface KeyTipTriggerEvent {
	readonly key: string
	readonly ctrlKey: boolean
	readonly metaKey: boolean
	readonly altKey: boolean
	readonly shiftKey: boolean
	readonly repeat: boolean
}

// "chord": Alt with the Windows (Command) key, as Office for the web, since a browser owns a bare Alt and F10.
// "alt": also a bare Alt and F10, as desktop Office, where the shell has no menu bar to take them.
export type KeyTipTriggerMode = "chord" | "alt"

// Reads the keys that show or hide the layer: the modifiers fire on release with no other key pressed meanwhile
// (Alt+Command+I is the browser's, not ours); F10 fires on press.
export function createKeyTipTrigger(mode: KeyTipTriggerMode): {
	keydown: (event: KeyTipTriggerEvent) => boolean
	keyup: (event: KeyTipTriggerEvent) => boolean
	reset: () => void
} {
	let armed = false

	return {
		keydown: event => {
			if (event.repeat) return false

			if (event.ctrlKey || event.shiftKey) {
				armed = false

				return false
			}

			if (event.key === "F10") {
				armed = false

				return mode === "alt" && !event.altKey && !event.metaKey
			}

			armed = (event.key === "Alt" && (event.metaKey || mode === "alt")) || (event.key === "Meta" && event.altKey)

			return false
		},
		keyup: event => {
			if (!armed || (event.key !== "Alt" && event.key !== "Meta")) return false

			armed = false

			return true
		},
		reset: () => {
			armed = false
		}
	}
}
