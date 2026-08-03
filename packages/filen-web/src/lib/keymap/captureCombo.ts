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

// Escape is the recorder's cancel key, never a recordable binding.
const CANCEL_KEY = "escape"

// What the surface should do with the recorder's current state: keep waiting, cancel the session, or
// commit the finished chord.
export type RecordingOutcome = { kind: "pending" } | { kind: "cancel" } | { kind: "commit"; combo: string }

const PENDING: RecordingOutcome = { kind: "pending" }
const CANCEL: RecordingOutcome = { kind: "cancel" }

// The one reader of react-hotkeys-hook's recorder state, kept here rather than inline in the surface so
// its two non-obvious rules are testable without a DOM:
//
//   - `isRecording`, not just "a session exists", gates the key set. useRecordHotkeys clears its keys in
//     start() and NEVER in stop(), and that reset only lands on the render after the flag flips — a set
//     read while the recorder is stopped still holds the PREVIOUS session's chord, which would otherwise
//     be committed to the next action rebound in the same mount with zero keypresses.
//   - A recorded Escape cancels. The surface's own capture handler catches Escape while focus is inside
//     it, but the recorder listens on `document`, so a press with focus anywhere else (the shortcuts list
//     is a plain page, not a modal) reaches the recorder and must not be saved as a binding.
export function recordingOutcome(keys: Iterable<string>, isRecording: boolean, isMac: boolean): RecordingOutcome {
	if (!isRecording) {
		return PENDING
	}

	const combo = normalizeRecordedCombo(keys, isMac)

	if (combo === null) {
		return PENDING
	}

	return combo.split("+").includes(CANCEL_KEY) ? CANCEL : { kind: "commit", combo }
}
