import { FontManager } from "../core/fonts/index"
import type { TextFonts } from "../core/presentation/text/resolve"
import { parseDataModel, type DataModel } from "../core/smartart/data"
import { layoutDiagram, type Box, type DiagramLayout, type LayoutOptions, type TextMeasurer } from "../core/smartart/interp"
import { parseLayoutDef, type LayoutDefinition } from "../core/smartart/layoutDef"
import { smartArtFontRequests, textAdapterMeasurer } from "../core/smartart/measure"
import { MeasureCache } from "../core/text/index"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"

// Small data models and layout definitions written for the SmartArt tests (ECMA-376 §21.4); nothing here comes
// from a shipped layout.

export const DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
export const MM = 36000

export const measurer: TextMeasurer = {
	// Every character is half an em wide, lines are 1.2 em; no wrapping.
	measure(text, fontPt) {
		const lines = text.split("\n")

		return { width: Math.max(...lines.map(l => l.length)) * fontPt * 6350, height: lines.length * fontPt * 12700 * 1.2 }
	}
}

// A tx node's constraints for no margins (a side no constraint sets takes 0.56 of the font size).
export const NO_MARGINS =
	'<dgm:constrLst><dgm:constr type="lMarg"/><dgm:constr type="rMarg"/><dgm:constr type="tMarg"/><dgm:constr type="bMarg"/></dgm:constrLst>'

export interface PointSpec {
	readonly id: string
	readonly text?: string
	readonly type?: string
	readonly prSet?: string
	readonly vars?: string
	// The parent's id; the doc point when absent.
	readonly parent?: string | undefined
}

// A data model: `nodes` in order under their parents (the doc point by default), each with its parent and sibling
// transitions, plus `extra` points (presentation points by default) outside the tree.
export function data(nodes: readonly PointSpec[], extra: readonly PointSpec[] = [], prSetDoc = ""): string {
	let pts = `<dgm:pt modelId="doc" type="doc"><dgm:prSet ${prSetDoc}/></dgm:pt>`
	let cxns = ""
	const order = new Map<string, number>()

	for (const node of nodes) {
		const parent = node.parent ?? "doc"
		const index = order.get(parent) ?? 0
		const t = node.text === undefined ? "" : `<dgm:t><a:bodyPr/><a:p><a:r><a:t>${node.text}</a:t></a:r></a:p></dgm:t>`
		const type = node.type === undefined ? "" : ` type="${node.type}"`

		order.set(parent, index + 1)
		pts += `<dgm:pt modelId="${node.id}"${type}><dgm:prSet ${node.prSet ?? ""}/>${t}</dgm:pt>`
		pts += `<dgm:pt modelId="${node.id}p" type="parTrans" cxnId="c${node.id}"/><dgm:pt modelId="${node.id}s" type="sibTrans" cxnId="c${node.id}"/>`
		cxns += `<dgm:cxn modelId="c${node.id}" srcId="${parent}" destId="${node.id}" srcOrd="${index}" destOrd="0" parTransId="${node.id}p" sibTransId="${node.id}s"/>`
	}

	for (const point of extra) {
		const vars = point.vars === undefined ? "" : `<dgm:presLayoutVars>${point.vars}</dgm:presLayoutVars>`

		pts += `<dgm:pt modelId="${point.id}" type="${point.type ?? "pres"}"><dgm:prSet ${point.prSet ?? ""}>${vars}</dgm:prSet></dgm:pt>`
	}

	return `<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A}"><dgm:ptLst>${pts}</dgm:ptLst><dgm:cxnLst>${cxns}</dgm:cxnLst></dgm:dataModel>`
}

export function layout(body: string, rootAttrs = ""): string {
	return `<dgm:layoutDef xmlns:dgm="${DGM}" uniqueId="test"><dgm:layoutNode name="root" ${rootAttrs}>${body}</dgm:layoutNode></dgm:layoutDef>`
}

export function model(dataXml: string): DataModel {
	return parseDataModel(parseXml(encodeUtf8(dataXml)))
}

export function definition(layoutXml: string): LayoutDefinition {
	return parseLayoutDef(parseXml(encodeUtf8(layoutXml)))
}

export function run(dataXml: string, layoutXml: string, w: number, h: number, options?: LayoutOptions, text = measurer): DiagramLayout {
	return layoutDiagram(model(dataXml), definition(layoutXml), undefined, undefined, { x: 0, y: 0, w, h }, text, options)
}

export function boxes(result: DiagramLayout, name: string): Box[] {
	return result.shapes.filter(s => s.name === name).map(s => s.box)
}

export function round(box: Box): Box {
	return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) }
}

// The ids of the points each shape named `name` presents, in drawing order.
export function presented(result: DiagramLayout, name?: string): string[] {
	return result.shapes.filter(s => name === undefined || s.name === name).map(s => s.text.map(p => p.id).join(","))
}

// The slide text adapter on the bundled OFL faces (Carlito for Calibri, the minor font of the default theme): a
// fresh measurer per call over one prepared environment.
export async function adapterMeasurers(texts: readonly string[], bold = false): Promise<() => TextMeasurer> {
	const fonts = new FontManager(nodeFontHost, nodeFontAssets, undefined, "fotest")
	const textFonts: TextFonts = { color: () => undefined, typeface: typeface => (typeface.startsWith("+") ? "Calibri" : typeface) }

	await fonts.prepare(smartArtFontRequests(texts, textFonts))

	if (bold) {
		const points = texts.map(text => ({
			id: text,
			type: "node" as const,
			paragraphs: [text],
			rich: [{ runs: [{ text, b: true }] }],
			props: {},
			parent: undefined,
			children: [],
			depth: 0
		}))

		await fonts.prepare(smartArtFontRequests(points, textFonts))
	}

	const env = { fonts, cache: new MeasureCache(new HmtxMeasurer()) }

	return () => textAdapterMeasurer(env, textFonts)
}

export async function adapterMeasurer(texts: readonly string[], bold = false): Promise<TextMeasurer> {
	return (await adapterMeasurers(texts, bold))()
}
