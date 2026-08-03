// Modifier tokens in react-hotkeys-hook's own vocabulary, in the order a combo string writes them.
// `meta` survives the fold only off mac (where it is the Windows/Super key, a distinct modifier from
// the primary one) — dropping it would silently save a weaker binding than the one recorded.
const MODIFIER_ORDER = ["mod", "meta", "ctrl", "alt", "shift"] as const

const MODIFIERS = new Set<string>(["shift", "alt", "ctrl", "control", "meta", "mod"])

// Turns a raw recorded key set (react-hotkeys-hook's useRecordHotkeys already emits its own token
// vocabulary — "meta", "shift", "s", "slash", …) into a storable combo string, or null while the
// user is still only holding modifiers.
//
// The platform-primary modifier folds to `mod`, the portable token every shipped default uses, so a
// binding recorded on one OS keeps working on another. A REAL ctrl chord on a mac is preserved as
// `ctrl` — there it is a distinct key from Command, not a spelling of it.
//
// `isMac` is a parameter rather than a call to isMacPlatform(): the fold has to match what
// react-hotkeys-hook itself resolves `mod` to, and passing it in keeps this function testable
// without touching globals.
export function normalizeRecordedCombo(keys: Iterable<string>, isMac: boolean): string | null {
	const primary = isMac ? "meta" : "ctrl"
	const present = new Set<string>()
	let key: string | null = null

	for (const raw of keys) {
		const token = raw.toLowerCase()

		if (!MODIFIERS.has(token)) {
			key = token
			continue
		}

		present.add(token === "control" ? "ctrl" : token)
	}

	if (key === null) {
		return null
	}

	const modifiers = new Set(present)

	if (modifiers.delete(primary)) {
		modifiers.add("mod")
	}

	return [...MODIFIER_ORDER.filter(modifier => modifiers.has(modifier)), key].join("+")
}
