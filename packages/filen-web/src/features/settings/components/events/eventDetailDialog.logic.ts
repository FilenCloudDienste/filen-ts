import type { DirColor } from "@filen/sdk-rs"
import type { FileIconKey } from "@/features/drive/lib/icon.logic"
import { FLAT_LISTING_KINDS } from "@/features/drive/lib/flatListing"
import { fileTypeExtension, previewCategoryForExtension } from "@/features/drive/lib/preview.logic"
import { previewKindLabelKey } from "@/features/drive/components/infoDialog.logic"
import { revealHiddenCharacters } from "@/features/transfers/components/jobReport.logic"
import {
	eventDetailSections,
	isMisleadingName,
	type EventDescription,
	type EventDetailField,
	type EventItemRef,
	type EventModelContext
} from "@/features/settings/lib/eventModel"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import type { EventsKey } from "@/lib/i18n"
import { asErrorDTO } from "@/lib/sdk/errors"

// The detail dialog's view model: the event model's sections, regrouped for display (a color change on
// one row, a share's contact, the resolved location, the type as a kind) and topped up with what only
// the dialog shows (device type, event UUID, stable ID, raw JSON).

export interface EventDetailColor {
	value: string
	hex: string
	// A custom color's hex, beside its name.
	hint?: string
}

export interface EventDetailRow {
	key: string
	label: string
	value: string
	// What the copy button writes; no button without it.
	copy?: string
	// An identifier, IP or user agent: monospace, truncated in the middle.
	opaque?: boolean
	// A muted aside after the value (a kind's MIME type).
	hint?: string
	swatch?: string
	colors?: { from: EventDetailColor; to: EventDetailColor }
	contact?: { email: string; name?: string; avatar?: string }
	// The directory "Open location" navigates to.
	location?: string
	// Shown in full behind a toggle (the user agent).
	collapsible?: boolean
	// Still resolving: no value yet.
	pending?: boolean
	// An item's name: isolated from the surrounding text's direction.
	name?: boolean
	// A name with invisible or direction-changing characters, shown revealed in `value`.
	misleading?: boolean
}

export type EventDetailSectionKey = "item" | "device" | "details"

export interface EventDetailSection {
	key: EventDetailSectionKey
	title: string
	rows: EventDetailRow[]
}

export interface EventDetailView {
	sections: EventDetailSection[]
	// An undecodable event's server JSON, pretty-printed.
	rawJson?: string
}

// The item's directory as the dialog knows it: a cached name, a resolved one, or still resolving.
export type EventDetailLocation = { status: "resolved"; uuid: string; name: string } | { status: "pending"; uuid: string }

export type EventHeroGlyph = { type: "file"; iconKey: FileIconKey } | { type: "directory"; color: DirColor } | { type: "action" }

const ITEM_META_KEYS: ReadonlySet<EventsKey> = new Set<EventsKey>([
	"eventsFieldName",
	"eventsFieldPreviousName",
	"eventsFieldNewName",
	"eventsFieldType",
	"eventsFieldSize",
	"eventsFieldModified"
])

const NAME_KEYS: ReadonlySet<EventsKey> = new Set<EventsKey>(["eventsFieldName", "eventsFieldPreviousName", "eventsFieldNewName"])

const COPY_KEYS: ReadonlySet<EventsKey> = new Set<EventsKey>([
	...NAME_KEYS,
	"eventsFieldCode",
	"eventsFieldEmail",
	"eventsFieldPreviousEmail",
	"eventsFieldNewEmail",
	"eventsFieldIpAddress",
	"eventsFieldUserAgent",
	"eventsFieldEventType",
	"eventsFieldEventId",
	"eventsFieldEventUuid",
	"eventsFieldItemId",
	"eventsFieldStableId",
	"eventsFieldLinkId"
])

const DEVICE_TYPE_KEYS = {
	desktop: "eventsValueDeviceDesktop",
	mobile: "eventsValueDeviceMobile",
	tablet: "eventsValueDeviceTablet"
} as const satisfies Record<string, EventsKey>

function fieldRow(field: EventDetailField, ctx: EventModelContext): EventDetailRow {
	const row: EventDetailRow = { key: field.labelKey, label: ctx.t(field.labelKey), value: field.value }
	const encrypted = NAME_KEYS.has(field.labelKey) && field.value === ctx.t("eventsValueEncrypted")

	if (COPY_KEYS.has(field.labelKey) && !encrypted) {
		row.copy = field.value
	}

	if (NAME_KEYS.has(field.labelKey) && !encrypted) {
		row.name = true

		if (isMisleadingName(field.value)) {
			row.misleading = true
			row.value = revealHiddenCharacters(field.value)
		}
	}

	if (field.hint !== undefined) {
		row.hint = field.hint
	}

	if (field.opaque === true) {
		row.opaque = true
	}

	if (field.color !== undefined) {
		row.swatch = field.color
	}

	return row
}

function idRow(labelKey: EventsKey, value: string, ctx: EventModelContext): EventDetailRow {
	return { key: labelKey, label: ctx.t(labelKey), value, copy: value, opaque: true }
}

// After the last row with one of `anchors`, else at `fallback`.
function insertAfter(rows: EventDetailRow[], row: EventDetailRow, anchors: readonly string[], fallback: "start" | "end"): void {
	let index = -1

	for (const [i, existing] of rows.entries()) {
		if (anchors.includes(existing.key)) {
			index = i
		}
	}

	rows.splice(index === -1 ? (fallback === "start" ? 0 : rows.length) : index + 1, 0, row)
}

function kindLabel(name: string | undefined, mime: string | undefined, ctx: EventModelContext): string | undefined {
	const category = previewCategoryForExtension(fileTypeExtension(name ?? "", mime))
	const key = category === null ? null : previewKindLabelKey(category)

	return key === null ? undefined : ctx.t(`drive:${key}`)
}

function colorText(field: EventDetailField): string {
	return field.hint === undefined ? field.value : `${field.value} (${field.hint})`
}

function detailColor(field: EventDetailField, hex: string): EventDetailColor {
	return field.hint === undefined ? { value: field.value, hex } : { value: field.value, hex, hint: field.hint }
}

function contactEmail(entry: EventEntry, labelKey: EventsKey): string | undefined {
	if (entry.type !== "ok") {
		return undefined
	}

	const kind = entry.event.kind

	if (labelKey === "eventsFieldSharedWith") {
		return kind.type === "fileShared" || kind.type === "folderShared" || kind.type === "removedSharedOutItems"
			? kind.receiverEmail
			: undefined
	}

	return labelKey === "eventsFieldSharedBy" && kind.type === "removedSharedInItems" ? kind.sharerEmail : undefined
}

function itemRows(
	entry: EventEntry,
	description: EventDescription,
	fields: readonly EventDetailField[],
	location: EventDetailLocation | undefined,
	ctx: EventModelContext
): EventDetailRow[] {
	const rows: EventDetailRow[] = []
	let previousColor: EventDetailField | undefined

	for (const field of fields) {
		switch (field.labelKey) {
			// Placed below from `location`, which knows its directory and a name resolved on open.
			case "eventsFieldLocation":
				break

			case "eventsFieldType": {
				const kind = kindLabel(description.meta?.name, field.value, ctx)

				rows.push(
					kind === undefined
						? fieldRow(field, ctx)
						: { key: field.labelKey, label: ctx.t(field.labelKey), value: kind, hint: field.value }
				)
				break
			}

			case "eventsFieldPreviousColor":
				previousColor = field
				break

			case "eventsFieldColor":
				if (previousColor?.color !== undefined && field.color !== undefined) {
					rows.push({
						key: field.labelKey,
						label: ctx.t(field.labelKey),
						value: `${colorText(previousColor)} → ${colorText(field)}`,
						colors: { from: detailColor(previousColor, previousColor.color), to: detailColor(field, field.color) }
					})
				} else {
					rows.push(...(previousColor === undefined ? [] : [fieldRow(previousColor, ctx)]), fieldRow(field, ctx))
				}

				break

			case "eventsFieldSharedWith":
			case "eventsFieldSharedBy": {
				const row = fieldRow(field, ctx)
				const email = contactEmail(entry, field.labelKey)

				if (email !== undefined) {
					const contact = ctx.contact(email)

					row.copy = email
					row.contact =
						contact === undefined || contact.name === email
							? { email }
							: contact.avatar === undefined
								? { email, name: contact.name }
								: { email, name: contact.name, avatar: contact.avatar }
				}

				rows.push(row)
				break
			}

			default:
				rows.push(fieldRow(field, ctx))
				break
		}
	}

	// No MIME type to name the kind by, but a name that does.
	if (description.item?.type === "file" && !rows.some(row => row.key === "eventsFieldType")) {
		const kind = kindLabel(description.meta?.name, undefined, ctx)

		if (kind !== undefined) {
			insertAfter(rows, { key: "eventsFieldType", label: ctx.t("eventsFieldType"), value: kind }, [...NAME_KEYS], "start")
		}
	}

	if (location !== undefined) {
		insertAfter(
			rows,
			location.status === "resolved"
				? { key: "eventsFieldLocation", label: ctx.t("eventsFieldLocation"), value: location.name, location: location.uuid }
				: { key: "eventsFieldLocation", label: ctx.t("eventsFieldLocation"), value: "", pending: true },
			[...ITEM_META_KEYS],
			"start"
		)
	}

	return rows
}

function deviceRows(description: EventDescription, fields: readonly EventDetailField[], ctx: EventModelContext): EventDetailRow[] {
	const rows = fields.map(field => {
		const row = fieldRow(field, ctx)

		if (field.labelKey === "eventsFieldUserAgent") {
			row.collapsible = true
		}

		return row
	})
	const type = description.device.device

	if (type !== "unknown") {
		const labelKey = "eventsFieldDeviceType"

		insertAfter(
			rows,
			{ key: labelKey, label: ctx.t(labelKey), value: ctx.t(DEVICE_TYPE_KEYS[type]) },
			["eventsFieldApp", "eventsFieldBrowser", "eventsFieldOperatingSystem"],
			"start"
		)
	}

	return rows
}

function detailRows(
	entry: EventEntry,
	description: EventDescription,
	fields: readonly EventDetailField[],
	ctx: EventModelContext
): EventDetailRow[] {
	const rows = fields.map(field => fieldRow(field, ctx))
	const eventUuid = entry.type === "ok" ? entry.event.uuid : entry.raw.uuid
	const stableUuid = description.item?.stableUuid

	if (eventUuid !== undefined) {
		insertAfter(rows, idRow("eventsFieldEventUuid", eventUuid, ctx), ["eventsFieldEventType", "eventsFieldEventId"], "start")
	}

	if (stableUuid !== undefined && stableUuid !== description.item?.uuid) {
		insertAfter(rows, idRow("eventsFieldStableId", stableUuid, ctx), ["eventsFieldEventUuid", "eventsFieldItemId"], "end")
	}

	return rows
}

function prettyJson(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2)
	} catch {
		return raw
	}
}

export function buildEventDetailView(
	entry: EventEntry,
	description: EventDescription,
	location: EventDetailLocation | undefined,
	ctx: EventModelContext
): EventDetailView {
	const fields = eventDetailSections(entry, description, ctx)
	const sections: EventDetailSection[] = [
		{ key: "item", title: ctx.t("eventsSectionItem"), rows: itemRows(entry, description, fields.item, location, ctx) },
		{ key: "device", title: ctx.t("eventsSectionDevice"), rows: deviceRows(description, fields.device, ctx) },
		{ key: "details", title: ctx.t("eventsSectionDetails"), rows: detailRows(entry, description, fields.details, ctx) }
	]
	const view: EventDetailView = { sections: sections.filter(section => section.rows.length > 0) }

	if (entry.type === "unknown") {
		view.rawJson = prettyJson(entry.event.raw)
	}

	return view
}

const PSEUDO_PARENTS: ReadonlySet<string> = new Set<string>(FLAT_LISTING_KINDS)

// The directory an event's item sat in, when it names one the drive can open, not a pseudo-parent.
export function eventLocationUuid(description: EventDescription): string | undefined {
	const parent = description.item?.parent

	return parent === undefined || parent.length === 0 || PSEUDO_PARENTS.has(parent) ? undefined : parent
}

// The item "Show in Cloud Drive" looks up: one with an id to look it up by. Legacy events carry none, and a
// deleted archived version names only itself.
export function eventLookupRef(description: EventDescription): EventItemRef | undefined {
	const item = description.item

	return item !== undefined &&
		item.versionOnly !== true &&
		(item.uuid !== undefined || (item.type === "file" && item.stableUuid !== undefined))
		? item
		: undefined
}

// Kinds where the server answered: it has no such event, or none this build can read. Anything else (a
// lost connection, an expired session) may well succeed again.
const NOT_FOUND_KINDS: ReadonlySet<string> = new Set(["Server", "Response", "Conversion"])

export function eventLookupFailure(error: unknown): "notFound" | "error" {
	const { kind } = asErrorDTO(error)

	return kind !== undefined && NOT_FOUND_KINDS.has(kind) ? "notFound" : "error"
}

// The d.ts types a directory's color as set; the server may leave it out or send null.
function directoryColor(color: DirColor | null | undefined): DirColor {
	return color === null || color === undefined || color.length === 0 ? "default" : color
}

export function eventHeroGlyph(entry: EventEntry, description: EventDescription): EventHeroGlyph {
	if (description.fileIcon !== undefined) {
		return { type: "file", iconKey: description.fileIcon }
	}

	if (description.item?.type === "directory") {
		const kind = entry.type === "ok" ? entry.event.kind : undefined

		return { type: "directory", color: directoryColor(kind?.type === "folderColorChanged" ? kind.color : undefined) }
	}

	return { type: "action" }
}

// "Copy details": every row the dialog shows, as plain text. The raw JSON keeps its own copy button.
export function eventDetailText(title: string, when: string, view: EventDetailView): string {
	const blocks = [`${title}\n${when}`]

	for (const section of view.sections) {
		const lines = section.rows
			.filter(row => row.pending !== true)
			.map(row => `${row.label}: ${row.value}${row.hint === undefined ? "" : ` (${row.hint})`}`)

		blocks.push(`${section.title}\n${lines.join("\n")}`)
	}

	return blocks.join("\n\n")
}
