import { escapeAttribute, escapeText } from "../../xml/entities"
import type { DocColor } from "../props"

// Markup helpers for the parts the conversion writes: strings joined once per part, attribute values escaped.

export const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
export const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
export const NS_PKG_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
export const NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
export const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
export const NS_PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"
export const NS_WPS = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
export const NS_WPG = "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"

export const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

// The root attributes of every WordprocessingML story part.
export const STORY_NAMESPACES = `xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}" xmlns:a="${NS_A}" xmlns:pic="${NS_PIC}" xmlns:wps="${NS_WPS}" xmlns:wpg="${NS_WPG}"`

export function attr(name: string, value: string | number): string {
	return ` ${name}="${typeof value === "number" ? String(Math.round(value)) : escapeAttribute(value)}"`
}

// <w:name w:val="value"/>
export function val(name: string, value: string | number): string {
	return `<w:${name}${attr("w:val", value)}/>`
}

// A toggle property: present for on, w:val="0" for an explicit off.
export function onOff(name: string, on: boolean): string {
	return on ? `<w:${name}/>` : `<w:${name} w:val="0"/>`
}

export function text(value: string): string {
	return escapeText(value)
}

// ST_HexColor: six hex digits, or "auto".
export function hexColor(color: DocColor): string {
	return color === "auto" ? "auto" : (color & 0xffffff).toString(16).toUpperCase().padStart(6, "0")
}

export function clamp(value: number, low: number, high: number): number {
	return Number.isFinite(value) ? Math.min(high, Math.max(low, Math.round(value))) : low
}
