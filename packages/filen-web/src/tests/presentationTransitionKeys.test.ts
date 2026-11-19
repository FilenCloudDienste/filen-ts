import { describe, expect, it } from "vitest"
import i18n, { type TFunction } from "i18next"
import { TRANSITION_PRESETS } from "@filen/office/core/anim"
import { BACKGROUND_PATTERNS } from "@filen/office/core/presentation"
import { transitionName, valueLabel } from "@/features/presentation/components/ribbon/transitions"
import "@/lib/i18n"

// Every transition, effect option value and background pattern the ribbon names has its catalog key: the names are
// built from office's catalogs, which the typed keys do not check.

interface Asked {
	readonly key: string
	readonly options: Record<string, unknown> | undefined
}

// A `t` that records the keys the labels ask for.
function recorder(): { readonly t: TFunction<"preview">; readonly asked: Asked[] } {
	const asked: Asked[] = []
	const t = ((key: string, options?: Record<string, unknown>) => {
		asked.push({ key, options })

		return key
	}) as unknown as TFunction<"preview">

	return { t, asked }
}

function missing(asked: readonly Asked[]): string[] {
	return asked.filter(entry => !i18n.exists(`preview:${entry.key}`, entry.options)).map(entry => entry.key)
}

describe("transition names", () => {
	it("names every preset and every option value", () => {
		const { t, asked } = recorder()

		transitionName(t, undefined)

		for (const preset of TRANSITION_PRESETS) {
			transitionName(t, preset)

			for (const spec of preset.options) if (spec.kind === "choice") for (const value of spec.values) valueLabel(t, spec, value)
		}

		expect(asked.length).toBeGreaterThan(TRANSITION_PRESETS.length)
		// The catalog is loaded: a key it lacks is reported.
		expect(missing([{ key: "previewPptxTransitionNoSuchKind", options: undefined }])).toEqual(["previewPptxTransitionNoSuchKind"])
		expect(missing(asked)).toEqual([])
	})

	it("names every background pattern", () => {
		expect(BACKGROUND_PATTERNS.filter(pattern => !i18n.exists(`preview:previewPptxDesignPattern_${pattern}`))).toEqual([])
	})
})
