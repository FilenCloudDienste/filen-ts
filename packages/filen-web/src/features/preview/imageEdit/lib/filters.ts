import type { Adjustments, ImageEditRecipe } from "@/features/preview/imageEdit/types"

// A filter is a set of adjustment offsets added on top of the user's own sliders, so picking one never moves them.
export interface FilterPreset {
	id: string
	labelKey: string
	adjustments: Partial<Adjustments>
}

export const FILTER_PRESETS: readonly FilterPreset[] = [
	{ id: "vivid", labelKey: "previewImageEditFilterVivid", adjustments: { saturation: 35, vibrance: 25, contrast: 15 } },
	{ id: "warm", labelKey: "previewImageEditFilterWarm", adjustments: { warmth: 35, tint: 5, saturation: 10 } },
	{ id: "cool", labelKey: "previewImageEditFilterCool", adjustments: { warmth: -35, tint: -5 } },
	{ id: "mono", labelKey: "previewImageEditFilterMono", adjustments: { saturation: -100, contrast: 10 } },
	{
		id: "noir",
		labelKey: "previewImageEditFilterNoir",
		adjustments: { saturation: -100, contrast: 45, shadows: -20, vignette: 30 }
	},
	{
		id: "fade",
		labelKey: "previewImageEditFilterFade",
		adjustments: { contrast: -25, shadows: 25, highlights: -10, saturation: -20 }
	},
	{
		id: "chrome",
		labelKey: "previewImageEditFilterChrome",
		adjustments: { contrast: 20, saturation: 20, highlights: -15, shadows: 10 }
	},
	{
		id: "dramatic",
		labelKey: "previewImageEditFilterDramatic",
		adjustments: { contrast: 40, highlights: -30, shadows: 30, saturation: -10, vignette: 25 }
	}
]

export function filterPreset(id: string | null): FilterPreset | null {
	return id === null ? null : (FILTER_PRESETS.find(preset => preset.id === id) ?? null)
}

// Sharpness and vignette run 0..100; the rest −100..100.
function clampAdjustment(key: keyof Adjustments, value: number): number {
	const min = key === "sharpness" || key === "vignette" ? 0 : -100

	return Math.min(100, Math.max(min, value))
}

// The adjustments to render: the user's plus the filter's, clamped. Without a filter, the user's own object. The video
// editor's recipe passes its own adjustments here too.
export function effectiveAdjustments(recipe: Pick<ImageEditRecipe, "adjustments" | "filter">): Adjustments {
	const preset = filterPreset(recipe.filter)

	if (preset === null) {
		return recipe.adjustments
	}

	const result = { ...recipe.adjustments }

	for (const [key, offset] of Object.entries(preset.adjustments) as [keyof Adjustments, number][]) {
		result[key] = clampAdjustment(key, result[key] + offset)
	}

	return result
}
