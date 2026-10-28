import { chartDataOf, type ChartData } from "../../../core/presentation/edit/apply/chart"
import { findShape } from "../../../core/presentation/edit/changes"
import { PresentationError, type ShapeRef } from "../../../core/presentation/model"
import type { CallContext } from "../engine"
import { viewParts } from "./view"

// The chart capability: what a chart frame holds for the Chart tab, and its data as a workbook for Edit Data
// (core/presentation/edit/apply/chart.ts chartDataOf), read from the version the frame names.

export async function chartData(context: CallContext, target: ShapeRef, options?: { readonly workbook?: boolean }): Promise<ChartData> {
	const session = context.session
	const parts = viewParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "chartData")

	const node = await parts.slide(target.slide, context.slicing)
	const shape = findShape(node.shapes, target.id)?.shape

	if (shape?.frame?.kind !== "chart") throw new PresentationError("notFound", `shape ${String(target.id)} is not a chart`)

	const data = await chartDataOf(
		session.deck,
		shape.frame,
		{ opc: parts.opc, document: part => parts.document(part) },
		options ?? {},
		context.slicing
	)

	if ("kind" in data) throw new PresentationError(data.reason, data.detail ?? "chartData")

	return data
}

export const chartCapability = { chartData }
