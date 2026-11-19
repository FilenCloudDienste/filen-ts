import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@filen/shared"
import type { Contact, ContactFile, ContactValue } from "@filen/shared/contactFile"
import { codeMirrorLanguageFor, itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { RenderedSourceViewer, type RenderedSource } from "@/features/preview/components/renderedSourceViewer"
import type { TextViewerProps } from "@/features/preview/components/textViewer"
import { MetadataCard } from "@/features/preview/components/metadataCard"
import { PreviewErrorState, PreviewLoading } from "@/features/preview/components/previewErrorState"
import type { MetadataField, MetadataSectionData } from "@/features/preview/lib/metadataCard.types"
import { readContactFile } from "@/features/preview/lib/textFamilyClient"
import { useTextFamilyReading } from "@/features/preview/hooks/useTextFamilyReading"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { clampListboxIndex, listboxKeyTarget, listboxPageStep } from "@/features/drive/lib/listbox"
import { withActiveRow } from "@/features/videos/lib/videoGrid.logic"

function typed(t: TFunction<"preview">, label: string, value: ContactValue): string {
	return value.types.length === 0 ? label : t("previewContactsTyped", { label, types: value.types.join(", ") })
}

// Phones and emails carry a Copy button; addresses and websites are text (never opened).
function contactSections(t: TFunction<"preview">, contact: Contact): MetadataSectionData[] {
	const reach: MetadataField[] = [
		...contact.phones.map(phone => ({ label: typed(t, t("previewContactsPhone"), phone), value: phone.value, copy: phone.value })),
		...contact.emails.map(email => ({ label: typed(t, t("previewContactsEmail"), email), value: email.value, copy: email.value }))
	]
	const more: MetadataField[] = [
		...contact.addresses.map(address => ({ label: typed(t, t("previewContactsAddress"), address), value: address.value })),
		...contact.urls.map(url => ({ label: typed(t, t("previewContactsWebsite"), url), value: url.value, mono: true }))
	]

	if (contact.nickname !== null) more.push({ label: t("previewContactsNickname"), value: contact.nickname })

	if (contact.birthday !== null) more.push({ label: t("previewContactsBirthday"), value: contact.birthday })

	if (contact.note !== null) more.push({ label: t("previewContactsNote"), value: contact.note })

	return [{ fields: reach }, { fields: more }].filter(section => section.fields.length > 0)
}

function subtitleOf(contact: Contact): string | undefined {
	const parts = [contact.title, contact.organization].filter(part => part !== null)

	return parts.length === 0 ? undefined : parts.join(" · ")
}

function ContactCard({ contact }: { contact: Contact }) {
	const { t } = useTranslation("preview")

	return (
		<MetadataCard
			title={contact.name === "" ? t("previewContactsUnnamed") : contact.name}
			subtitle={subtitleOf(contact)}
			sections={contactSections(t, contact)}
		/>
	)
}

// Cards past the cap: an exact count, or a lower bound when reading stopped before the file's end.
function omittedNote(t: TFunction<"preview">, count: number, truncated: boolean): string | null {
	if (truncated) {
		return ` · ${count > 0 ? t("previewContactsOmittedAtLeast", { count }) : t("previewContactsTruncated")}`
	}

	return count > 0 ? ` · ${t("previewContactsOmitted", { count })}` : null
}

const ROW_HEIGHT = 52

// A listbox with one tab stop, the selected card: arrows, Home, End and Page keys move the selection and the focus with it.
function ContactList({ file, selected, onSelect }: { file: ContactFile; selected: number; onSelect: (index: number) => void }) {
	const { t } = useTranslation("preview")
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const count = file.contacts.length
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => ROW_HEIGHT,
		overscan: 8,
		// The selected option stays mounted, so the list keeps its tab stop when scrolled away from it.
		rangeExtractor: range => withActiveRow(defaultRangeExtractor(range), selected, range.count)
	})
	// The option a key moved to, focused once it is rendered selected.
	const focusPending = useRef<number | null>(null)
	const label = t("previewContactsCount", { count })

	useEffect(() => {
		const pending = focusPending.current

		if (pending === null || scrollElement === null) {
			return
		}

		const option = scrollElement.querySelector<HTMLElement>(`[data-index="${String(pending)}"]`)

		if (option !== null) {
			focusPending.current = null
			option.focus({ preventScroll: true })
		}
	})

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || scrollElement === null) {
			return
		}

		const target = listboxKeyTarget(event.key, selected, count, 1, false, listboxPageStep(scrollElement.clientHeight, ROW_HEIGHT, 1))

		if (target === null) {
			return
		}

		event.preventDefault()

		const next = clampListboxIndex(target, count)

		virtualizer.scrollToIndex(next)

		// A key that keeps the selection commits no render, so a pending focus would fire on some later, unrelated render.
		if (next === selected) {
			scrollElement.querySelector<HTMLElement>(`[data-index="${String(next)}"]`)?.focus({ preventScroll: true })

			return
		}

		focusPending.current = next
		onSelect(next)
	}

	return (
		<div className="flex min-h-0 flex-col border-border/50 max-md:max-h-64 max-md:border-b md:w-72 md:border-e">
			<p className="px-4 py-2 text-xs text-muted-foreground">
				{label}
				{omittedNote(t, file.contactsOmitted, file.truncated)}
			</p>
			<div
				ref={setScrollElement}
				role="listbox"
				aria-label={label}
				className="min-h-0 flex-1 overflow-y-auto"
				onKeyDown={onKeyDown}
			>
				<div
					className="relative w-full"
					style={{ height: virtualizer.getTotalSize() }}
				>
					{virtualizer.getVirtualItems().map(virtualRow => {
						const contact = file.contacts[virtualRow.index]

						if (contact === undefined) {
							return null
						}

						const active = virtualRow.index === selected

						return (
							<button
								key={virtualRow.key}
								type="button"
								role="option"
								aria-selected={active}
								aria-setsize={count}
								aria-posinset={virtualRow.index + 1}
								data-index={virtualRow.index}
								tabIndex={active ? 0 : -1}
								className={cn(
									"absolute top-0 left-0 flex w-full flex-col justify-center px-4 text-start text-sm hover:bg-accent/50",
									active ? "bg-accent" : null
								)}
								style={{ height: ROW_HEIGHT, transform: `translateY(${String(virtualRow.start)}px)` }}
								onClick={() => {
									onSelect(virtualRow.index)
								}}
							>
								<span className="truncate font-medium">
									<bdi>{contact.name === "" ? t("previewContactsUnnamed") : contact.name}</bdi>
								</span>
								{contact.organization === null ? null : (
									<span className="truncate text-xs text-muted-foreground">
										<bdi>{contact.organization}</bdi>
									</span>
								)}
							</button>
						)
					})}
				</div>
			</div>
		</div>
	)
}

function Contacts({ file }: { file: ContactFile }) {
	const { t } = useTranslation("preview")
	const [chosen, setSelected] = useState(0)
	// A reading of fewer cards (the source edited down) keeps a card selected.
	const selected = clampListboxIndex(chosen, file.contacts.length)
	const contact = file.contacts[selected]

	if (contact === undefined) {
		return <PreviewErrorState message={t("previewContactsEmpty")} />
	}

	if (file.contacts.length === 1) {
		return (
			<div className="size-full overflow-y-auto p-4 sm:p-6">
				<div className="mx-auto max-w-2xl">
					<ContactCard contact={contact} />
				</div>
			</div>
		)
	}

	return (
		<div className="flex size-full flex-col md:flex-row">
			<ContactList
				file={file}
				selected={selected}
				onSelect={setSelected}
			/>
			<div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
				<div className="mx-auto max-w-2xl">
					<ContactCard contact={contact} />
				</div>
			</div>
		</div>
	)
}

function ContactsView({ source }: { source: RenderedSource }) {
	const { t } = useTranslation("preview")
	const reading = useTextFamilyReading(source.file.text, readContactFile, "contacts")

	if (reading.status === "pending") {
		return <PreviewLoading />
	}

	if (reading.status === "failed") {
		return <PreviewErrorState message={t("previewContactsFailed")} />
	}

	return <Contacts file={reading.value} />
}

function renderContacts(source: RenderedSource) {
	return <ContactsView source={source} />
}

// A contact file: one card, or a list beside the selected card; phones and emails copy, nothing is opened or fetched.
// Its source a toggle away.
// No parameter defaults: the React Compiler skips a component that has them.
export function ContactViewer({ item, alt, editable, onDirtyChange, contentRef, locked, onTextState, readAs }: TextViewerProps) {
	const { t } = useTranslation("preview")

	return (
		<RenderedSourceViewer
			item={item}
			alt={alt}
			renderer={renderContacts}
			tag={codeMirrorLanguageFor(itemTypeExtension(item))}
			formatting={false}
			labels={{ view: t("previewContactsView"), rendered: t("previewContactsCards") }}
			{...(editable === undefined ? {} : { editable })}
			{...(onDirtyChange === undefined ? {} : { onDirtyChange })}
			{...(contentRef === undefined ? {} : { contentRef })}
			{...(locked === undefined ? {} : { locked })}
			{...(onTextState === undefined ? {} : { onTextState })}
			{...(readAs === undefined ? {} : { readAs })}
		/>
	)
}
