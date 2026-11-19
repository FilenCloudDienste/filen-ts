import type { TextAnchor, TextParagraph } from "../displayList"
import { D } from "../reader"
import { plainParagraph, type TextDefaults } from "../text"
import { estimateHeight, estimateWidth, labelBody, type ChartBuilder, type Rect } from "./builder"
import { formatNumber } from "./format"

// Data labels (c:dLbls, c:dLbl): which parts show, where and how they are formatted.

export interface LabelConfig {
	readonly value: boolean
	readonly category: boolean
	readonly series: boolean
	readonly percent: boolean
	readonly separator: string
	readonly position: string
	readonly format: string | undefined
	readonly text: TextDefaults
}

export interface SeriesLabels {
	readonly base: LabelConfig | undefined
	// c:dLbl per point index; undefined for a deleted label.
	readonly points: ReadonlyMap<number, LabelConfig | undefined>
}

function readConfig(builder: ChartBuilder, node: number, inherited: LabelConfig | undefined): LabelConfig | undefined {
	const reader = builder.reader

	if (node < 0) return inherited

	const deleted = reader.child(node, D.C, "delete")

	if (deleted >= 0 && reader.bool(deleted, "val", true)) return undefined

	const shown = (local: string, fallback: boolean): boolean => {
		const child = reader.child(node, D.C, local)

		return child < 0 ? fallback : reader.bool(child, "val", true)
	}
	const numFmt = reader.child(node, D.C, "numFmt")
	const separator = reader.child(node, D.C, "separator")
	const position = reader.attr(reader.child(node, D.C, "dLblPos"), "val")

	return {
		value: shown("showVal", inherited?.value ?? false),
		category: shown("showCatName", inherited?.category ?? false),
		series: shown("showSerName", inherited?.series ?? false),
		percent: shown("showPercent", inherited?.percent ?? false),
		separator: separator >= 0 ? reader.text(separator) : (inherited?.separator ?? ", "),
		position: position ?? inherited?.position ?? "",
		format: numFmt >= 0 && !reader.bool(numFmt, "sourceLinked", false) ? reader.attr(numFmt, "formatCode") : inherited?.format,
		text: builder.textProps(reader.child(node, D.C, "txPr"), inherited?.text ?? builder.text)
	}
}

function visible(config: LabelConfig | undefined): config is LabelConfig {
	return config !== undefined && (config.value || config.category || config.series || config.percent)
}

// The labels of one series: the plot's c:dLbls under the series' own.
export function seriesLabels(builder: ChartBuilder, plotLabels: number, seriesNode: number): SeriesLabels | undefined {
	const reader = builder.reader
	const own = reader.child(seriesNode, D.C, "dLbls")
	const base = readConfig(builder, own, readConfig(builder, plotLabels, undefined))
	const points = new Map<number, LabelConfig | undefined>()

	for (const dLbl of reader.children(own, D.C, "dLbl")) {
		const index = reader.number(reader.child(dLbl, D.C, "idx"), "val", -1)

		if (index >= 0) points.set(index, readConfig(builder, dLbl, base))
	}

	if (!visible(base) && ![...points.values()].some(visible)) return undefined

	return { base, points }
}

// Data labels one chart draws; a label per point of a huge series is unreadable anyway, and each one is a
// text placeholder for layout.
export const MAX_DATA_LABELS = 4096

// The label configuration of one point, or undefined when it shows no label or `pending` (the labels
// collected so far) is full.
export function pointConfig(labels: SeriesLabels, index: number, pending: readonly PendingLabel[]): LabelConfig | undefined {
	if (pending.length >= MAX_DATA_LABELS) return undefined

	const config = labels.points.has(index) ? labels.points.get(index) : labels.base

	return visible(config) ? config : undefined
}

export function labelText(
	config: LabelConfig,
	seriesName: string,
	category: string,
	value: number,
	valueFormat: string,
	share: number,
	date1904: boolean
): string {
	const parts: string[] = []

	if (config.series) parts.push(seriesName)
	if (config.category) parts.push(category)
	if (config.value) parts.push(formatNumber(value, config.format ?? valueFormat, date1904))
	if (config.percent && Number.isFinite(share))
		parts.push(formatNumber(share, config.format !== undefined && config.format.includes("%") ? config.format : "0%", date1904))

	return parts.join(config.separator)
}

// A placed label waiting to be emitted after the axes.
export interface PendingLabel {
	readonly paragraphs: readonly TextParagraph[]
	readonly box: Rect
	readonly anchor: TextAnchor
	readonly source: number
}

// A label box beside (x, y): `side` is where the box sits relative to the point.
export function placeLabel(
	text: string,
	config: LabelConfig,
	x: number,
	y: number,
	side: "t" | "b" | "l" | "r" | "ctr",
	source: number
): PendingLabel {
	const width = estimateWidth(text, config.text.size) + 4
	const height = estimateHeight(config.text.size, text.split("\n").length)
	const gap = 3
	const box: Rect =
		side === "t"
			? { x: x - width / 2, y: y - gap - height, w: width, h: height }
			: side === "b"
				? { x: x - width / 2, y: y + gap, w: width, h: height }
				: side === "l"
					? { x: x - gap - width, y: y - height / 2, w: width, h: height }
					: side === "r"
						? { x: x + gap, y: y - height / 2, w: width, h: height }
						: { x: x - width / 2, y: y - height / 2, w: width, h: height }
	const align = side === "l" ? "r" : side === "r" ? "l" : "ctr"

	return { paragraphs: [plainParagraph(text, config.text, align)], box, anchor: side === "t" ? "b" : side === "b" ? "t" : "ctr", source }
}

export function emitLabels(builder: ChartBuilder, pending: readonly PendingLabel[]): void {
	for (const label of pending) builder.label(label.paragraphs, label.box, labelBody(label.anchor), label.source)
}
