import type { DicomInfo } from "@/features/preview/lib/dicom/protocol"

// The DICOM viewer's pure parts: its window presets and the frame requests it sends the worker.

export type CtPreset = "softTissue" | "lung" | "bone" | "brain" | "liver" | "mediastinum"

// The usual CT windows, in Hounsfield units.
export const CT_PRESETS: readonly { readonly id: CtPreset; readonly center: number; readonly width: number }[] = [
	{ id: "softTissue", center: 40, width: 400 },
	{ id: "lung", center: -600, width: 1500 },
	{ id: "bone", center: 400, width: 1800 },
	{ id: "brain", center: 40, width: 80 },
	{ id: "liver", center: 30, width: 150 },
	{ id: "mediastinum", center: 50, width: 350 }
]

export type WindowPresetEntry =
	| { readonly kind: "default" }
	// The file's own windows past its first (the default), by place in the file.
	| {
			readonly kind: "file"
			readonly index: number
			readonly explanation: string | null
			readonly center: number
			readonly width: number
	  }
	| { readonly kind: "ct"; readonly id: CtPreset; readonly center: number; readonly width: number }

export function windowPresets(info: Pick<DicomInfo, "windows" | "hounsfield">): readonly WindowPresetEntry[] {
	return [
		{ kind: "default" },
		...info.windows.slice(1).map((window, i) => ({ kind: "file" as const, index: i + 2, ...window })),
		...(info.hounsfield ? CT_PRESETS.map(preset => ({ kind: "ct" as const, ...preset })) : [])
	]
}

// The preset `window` is, if any: the default while nothing has changed it, else the first with its numbers.
export function presetOf(
	presets: readonly WindowPresetEntry[],
	window: { readonly center: number; readonly width: number } | null,
	atDefault: boolean
): WindowPresetEntry | null {
	if (window === null || atDefault) {
		return presets[0] ?? null
	}

	return presets.find(preset => preset.kind !== "default" && preset.center === window.center && preset.width === window.width) ?? null
}

// A window figure as shown: whole above 100, two significant decimals below (a PET's SUV window, say).
export function windowFigure(value: number): string {
	const magnitude = Math.abs(value)

	return magnitude >= 100 ? String(Math.round(value)) : String(Number(value.toPrecision(magnitude >= 10 ? 3 : 2)))
}

// Frame requests to the worker, one in flight: a newer request replaces one still waiting, so a dragged slider or a
// held key decodes only the frames it settles on. `onOutcome` hears each frame shown, or why not.
export function frameRequester<Outcome>(show: (frame: number) => Promise<Outcome>, onOutcome: (frame: number, outcome: Outcome) => void) {
	let waiting: number | null = null
	let busy = false

	const pump = (): void => {
		if (busy || waiting === null) return

		const frame = waiting

		waiting = null
		busy = true
		show(frame).then(
			outcome => {
				busy = false
				onOutcome(frame, outcome)
				pump()
			},
			() => {
				busy = false
				pump()
			}
		)
	}

	return (frame: number): void => {
		waiting = frame
		pump()
	}
}
