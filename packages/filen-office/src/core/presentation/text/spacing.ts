import { LineRule } from "../../text/index"
import type { Spacing } from "../model"

// Line and paragraph spacing of DrawingML text (ECMA-376 §21.1.2.2.5 lnSpc, .9 spcAft, .10 spcBef, .11 spcPct,
// .12 spcPts).
//
// - The single line is font-independent: 1.2 times the largest size on the line with the baseline at 1.0 of it
//   (body.ts gives every face these metrics). ECMA states the dependence on the point size only (§21.1.2.2.5); the
//   1.2 factor is LibreOffice 7.5's EditEngine (ImplCalculateFontIndependentLineSpacing), measured on its PDFs, which
//   RULES allow where PowerPoint documents nothing.
// - lnSpc a:spcPct: a multiple of that single line; a:spcPts: an exact height in hundredths of a point.
// - normAutofit lnSpcReduction (§21.1.2.1.3) takes its percentage off a proportional spacing (100% with 20%
//   reduction is 80%), as PowerPoint writes it and LibreOffice 7.5 applies it; exact spacing is not reduced.
// - spcBef/spcAft a:spcPct are a percentage of the largest text size on the line next to the space (§21.1.2.2.11:
//   "the largest text size having precedence"): the paragraph's first line before it, its last line after it;
//   a:spcPts are points. The spacing after one paragraph and before the next add up (no collapsing).
// - Below 100% the line keeps its baseline at no more than 0.8 of the reduced height (LibreOffice's EditEngine,
//   ImpEditEngine::CreateLines, measured against its PDFs); above 100% the extra goes above the text.

export const PT_PX = 96 / 72

export interface LineSpacing {
	readonly rule: (typeof LineRule)[keyof typeof LineRule]
	// AUTO: a multiple of single; EXACT: px.
	readonly value: number
}

const SINGLE: LineSpacing = { rule: LineRule.AUTO, value: 1 }

export function lineSpacing(spacing: Spacing | undefined, reduction: number, scale: number): LineSpacing {
	if (spacing === undefined) return reduction > 0 ? { rule: LineRule.AUTO, value: Math.max(0.1, 1 - reduction) } : SINGLE

	if ("pct" in spacing) return { rule: LineRule.AUTO, value: Math.max(0, spacing.pct / 100000 - reduction) }

	return { rule: LineRule.EXACT, value: Math.max(0, (spacing.pts / 100) * PT_PX * scale) }
}

// Space before or after a paragraph, px; `fontPx` is the largest font size as drawn on the line next to it.
export function paragraphSpace(spacing: Spacing | undefined, fontPx: number, scale: number): number {
	if (spacing === undefined) return 0

	if ("pct" in spacing) return Math.max(0, (spacing.pct / 100000) * fontPx)

	return Math.max(0, (spacing.pts / 100) * PT_PX * scale)
}
