// Quill format backward-compat shim: translate Quill 2.0.3 editor output (mobile, web) to the Quill
// 1.3.7 on-disk form that the old web client and desktop (and checklistParser) read.
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
// a note saved in v2 form is read by old web/desktop as a plain numbered list / plain paragraphs with
// the code's indentation collapsed. Quill v2's importer understands BOTH forms, so a v2 editor renders
// v1-authored notes correctly on open; the corruption only happens on SAVE. This shim rewrites the v2
// output back to the exact v1 form before it leaves the editor, leaving all other markup untouched, so
// the on-disk format stays v1 — the format every client supports.
//
// The output reproduces Quill v1's exact getHTML() form (verified byte-for-byte against real Quill
// 1.3.7): old web's react-quill re-fires onChange on load whenever getHTML(convert(stored)) !== stored,
// so a non-canonical v1 dialect would make old web re-save the note once on open.
//
// Needs a DOM (document.createElement), so it lives behind "@filen/shared/dom" and must never be
// re-exported from the platform-free main barrel.

const DATA_LIST = /\bdata-list\s*=/

// Map a v2 <li data-list> value to its v1 container open tag. Anything unexpected (missing / empty /
// unknown — never emitted by real Quill v2 output) defensively falls back to a plain bullet <ul>,
// matching Quill v1's "a <ul> with no data-checked is a bullet list".
function legacyOpenTag(dataList: string | null): string {
	switch (dataList) {
		case "ordered": {
			return "<ol>"
		}

		case "checked": {
			return "<ul data-checked=\"true\">"
		}

		case "unchecked": {
			return "<ul data-checked=\"false\">"
		}

		default: {
			return "<ul>"
		}
	}
}

function closeTagOf(openTag: string): string {
	return openTag.startsWith("<ol") ? "</ol>" : "</ul>"
}

// Build one v1 <li> from a v2 <li>: strip the Quill v2 toggle UI span (class-gated — a user's own inline
// <span> must survive), drop data-list, keep the class (preserves ql-indent-N), and normalize an empty
// item to <li><br></li> (the empty form Quill v1 and @filen/shared checklistParser both use).
function buildLegacyListItem(li: Element): string {
	for (const ui of Array.from(li.querySelectorAll("span.ql-ui"))) {
		ui.remove()
	}

	const className = li.getAttribute("class")
	const classAttr = className ? ` class="${className}"` : ""
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
	let current: string | null = null

	for (const li of Array.from(list.children)) {
		if (li.tagName !== "LI") {
			continue
		}

		const open = legacyOpenTag(li.getAttribute("data-list"))

		if (open !== current) {
			if (current) {
				out += closeTagOf(current)
			}

			out += open
			current = open
		}

		out += buildLegacyListItem(li)
	}

	if (current) {
		out += closeTagOf(current)
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

// Block conversions from the previous call. Both converters are pure functions of the block markup, and
// editors re-serialize the whole note on every keystroke, so unchanged blocks skip the DOM parse. Only one
// generation is kept, which bounds retention to the previous call's blocks. List keys start with <ol/<ul
// and code keys with <div, so the two converters never share a key.
let previousBlocks = new Map<string, string>()

// Translate Quill v2 list + code-block markup in an HTML string to the Quill v1 form. All other markup
// is returned byte-for-byte unchanged. Idempotent: v1 output carries no data-list / ql-code-block, so a
// second pass is a no-op.
export function quillV2ToLegacyV1(html: string): string {
	if (!DATA_LIST.test(html) && !html.includes("ql-code-block-container")) {
		if (previousBlocks.size > 0) {
			previousBlocks.clear()
		}

		return html
	}

	const blocks = new Map<string, string>()

	const convertOnce = (block: string, convert: (containerHtml: string) => string): string => {
		const converted = blocks.get(block) ?? previousBlocks.get(block) ?? convert(block)

		blocks.set(block, converted)

		return converted
	}

	let out = html

	// Lists: v2 emits every list as a flat, non-nesting <ol> (ListContainer.allowedChildren = [ListItem]),
	// and <ol>/<ul> only ever come from lists — so each <ol|ul>…</ol|ul> is a self-contained block with an
	// unambiguous close (user "<" is escaped to &lt; inside, so no literal </ol> can appear in item text).
	// Rewrite only the blocks that actually carry data-list; leave already-v1 containers untouched.
	out = out.replace(/<(ol|ul)\b[^>]*>[\s\S]*?<\/\1>/gi, block =>
		DATA_LIST.test(block) ? convertOnce(block, convertListContainer) : block
	)

	// Code blocks: a <div class="ql-code-block-container"> wraps per-line <div class="ql-code-block">
	// children with no deeper nesting (CodeBlockContainer.allowedChildren = [CodeBlock]), so the block
	// ends at the first "</div></div>" (line-close + container-close); middle line-closes are always
	// followed by "<div", never "</div>".
	out = out.replace(/<div\b[^>]*\bclass="ql-code-block-container"[^>]*>[\s\S]*?<\/div><\/div>/gi, block =>
		convertOnce(block, convertCodeBlockContainer)
	)

	previousBlocks = blocks

	return out
}
