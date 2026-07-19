// Quill format backward-compat shim (mobile-side): translate this app's Quill 2.0.3 editor output to
// the Quill 1.3.7 on-disk form that web + desktop (and @filen/utils) read.
//
// Notes are stored as raw Quill HTML (root.innerHTML), shared byte-for-byte across clients. Two
// constructs serialize incompatibly between the versions:
//
//   Lists — v1 encodes the type on the CONTAINER, v2 on each <li>:
//     v1  <ul data-checked="true"><li>A</li></ul> / <ul><li>A</li></ul> / <ol><li>A</li></ol>
//     v2  <ol><li data-list="checked|unchecked|bullet|ordered">A</li></ol>   (+ a <span class="ql-ui"> per <li>)
//   Code blocks — v1 is a single <pre>, v2 is a container of per-line <div>s:
//     v1  <pre class="ql-syntax" spellcheck="false">line1\nline2\n</pre>
//     v2  <div class="ql-code-block-container"><div class="ql-code-block">line1</div><div class="ql-code-block">line2</div></div>
//
// Quill v1 derives lists from the container (it ignores <li data-list>) and code blocks from <pre>, so
// a note saved in v2 form is read by web/desktop as a plain numbered list / plain paragraphs with the
// code's indentation collapsed. Quill v2's importer understands BOTH forms, so this app renders
// web-authored notes correctly on open; the corruption only happens on SAVE. This shim rewrites the v2
// output back to the exact v1 form before it leaves the editor, leaving all other markup untouched, so
// the on-disk format stays v1 — the format every client supports.
//
// The output reproduces Quill v1's exact getHTML() form (verified byte-for-byte against real Quill
// 1.3.7): web's react-quill re-fires onChange on load whenever getHTML(convert(stored)) !== stored, so
// a non-canonical v1 dialect would make web re-save the note once on open.

type LegacyContainer = {
	tag: "ul" | "ol"
	// "true" / "false" for a checklist <ul data-checked>; null for a plain bullet <ul> or ordered <ol>.
	checked: "true" | "false" | null
}

// Map a v2 <li data-list> value to its v1 container. Anything unexpected (missing / empty / unknown —
// never emitted by real Quill v2 output) defensively falls back to a plain bullet <ul>, matching Quill
// v1's "a <ul> with no data-checked is a bullet list".
function dataListToLegacyContainer(dataList: string | null): LegacyContainer {
	switch (dataList) {
		case "ordered": {
			return {
				tag: "ol",
				checked: null
			}
		}

		case "checked": {
			return {
				tag: "ul",
				checked: "true"
			}
		}

		case "unchecked": {
			return {
				tag: "ul",
				checked: "false"
			}
		}

		default: {
			return {
				tag: "ul",
				checked: null
			}
		}
	}
}

function sameContainer(a: LegacyContainer, b: LegacyContainer): boolean {
	return a.tag === b.tag && a.checked === b.checked
}

function openTag(container: LegacyContainer): string {
	if (container.checked !== null) {
		return `<ul data-checked="${container.checked}">`
	}

	return `<${container.tag}>`
}

// Build one v1 <li> from a v2 <li>: strip the Quill v2 toggle UI span (class-gated — a user's own inline
// <span> must survive), drop data-list, keep the class (preserves ql-indent-N), and normalize an empty
// item to <li><br></li> (the empty form Quill v1 and @filen/utils checklistParser both use).
function buildLegacyListItem(li: Element): string {
	for (const ui of Array.from(li.querySelectorAll("span.ql-ui"))) {
		ui.remove()
	}

	const className = li.getAttribute("class")
	const classAttr = className && className.length > 0 ? ` class="${className}"` : ""
	const content = li.textContent && li.textContent.trim().length > 0 ? li.innerHTML : "<br>"

	return `<li${classAttr}>${content}</li>`
}

// Convert a single v2 list container's HTML into a run of v1 containers, grouping consecutive items of
// the same v1 type into one container (mirrors Quill v1's List.optimize()).
function convertListContainer(containerHtml: string): string {
	const wrapper = document.createElement("div")

	wrapper.innerHTML = containerHtml

	const list = wrapper.firstElementChild

	if (!list) {
		return containerHtml
	}

	let out = ""
	let current: LegacyContainer | null = null

	for (const li of Array.from(list.children)) {
		if (li.tagName !== "LI") {
			continue
		}

		const container = dataListToLegacyContainer(li.getAttribute("data-list"))

		if (!current || !sameContainer(current, container)) {
			if (current) {
				out += `</${current.tag}>`
			}

			out += openTag(container)
			current = container
		}

		out += buildLegacyListItem(li)
	}

	if (current) {
		out += `</${current.tag}>`
	}

	return out
}

// Convert a single v2 code-block container into Quill v1's single <pre>. Each per-line <div
// class="ql-code-block"> becomes one line; lines are joined with "\n" plus a trailing "\n", and the
// text is HTML-escaped by the DOM serializer exactly as Quill v1 does (build via textContent, read
// outerHTML) so the result is byte-identical to Quill v1's getHTML() — a v1 fixed point.
function convertCodeBlockContainer(containerHtml: string): string {
	const wrapper = document.createElement("div")

	wrapper.innerHTML = containerHtml

	const container = wrapper.firstElementChild

	if (!container) {
		return containerHtml
	}

	const lines = Array.from(container.children).map(line => line.textContent ?? "")
	const pre = document.createElement("pre")

	pre.setAttribute("class", "ql-syntax")
	pre.setAttribute("spellcheck", "false")
	pre.textContent = `${lines.join("\n")}\n`

	return pre.outerHTML
}

// Translate Quill v2 list + code-block markup in an HTML string to the Quill v1 form. All other markup
// is returned byte-for-byte unchanged. Idempotent: v1 output carries no data-list / ql-code-block, so a
// second pass is a no-op.
export function quillV2ToLegacyV1(html: string): string {
	if (!/\bdata-list\s*=/.test(html) && !html.includes("ql-code-block-container")) {
		return html
	}

	let out = html

	// Lists: v2 emits every list as a flat, non-nesting <ol> (ListContainer.allowedChildren = [ListItem]),
	// and <ol>/<ul> only ever come from lists — so each <ol|ul>…</ol|ul> is a self-contained block with an
	// unambiguous close (user "<" is escaped to &lt; inside, so no literal </ol> can appear in item text).
	// Rewrite only the blocks that actually carry data-list; leave already-v1 containers untouched.
	out = out.replace(/<(ol|ul)\b[^>]*>[\s\S]*?<\/\1>/gi, block =>
		/\bdata-list\s*=/.test(block) ? convertListContainer(block) : block
	)

	// Code blocks: a <div class="ql-code-block-container"> wraps per-line <div class="ql-code-block">
	// children with no deeper nesting (CodeBlockContainer.allowedChildren = [CodeBlock]), so the block
	// ends at the first "</div></div>" (line-close + container-close); middle line-closes are always
	// followed by "<div", never "</div>".
	out = out.replace(/<div\b[^>]*\bclass="ql-code-block-container"[^>]*>[\s\S]*?<\/div><\/div>/gi, block =>
		convertCodeBlockContainer(block)
	)

	return out
}

export default quillV2ToLegacyV1
