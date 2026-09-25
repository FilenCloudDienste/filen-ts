import { describe, it, expect } from "vitest"
import { parse, HTMLElement, TextNode } from "node-html-better-parser"
import { checklistParser, decodeHtmlEntities } from "@filen/shared"

// The rows node-html-better-parser itself reads from the note as stored, on notes it reads quickly.
function asStored(html: string): [boolean, string][] {
	const rows: [boolean, string][] = []

	for (const ul of parse(html).querySelectorAll("ul")) {
		const checked = ul.getAttribute("data-checked") === "true"

		for (const li of ul.querySelectorAll("li")) {
			rows.push([checked, decodeHtmlEntities(li.rawText).trim()])
		}
	}

	return rows
}

// The parser's tree read once: each `li` inside a `ul`, under the nearest one, without the text of the rows nested in it.
function readOnce(html: string): [boolean, string][] {
	const rows: [boolean, string][] = []

	function walk(node: HTMLElement, ul: HTMLElement | undefined, own: string[] | undefined): void {
		for (const child of node.childNodes) {
			if (child instanceof TextNode) {
				own?.push(child.rawText)
			} else if (child instanceof HTMLElement && child.tagName === "li" && ul !== undefined) {
				const checked = ul.getAttribute("data-checked") === "true"
				const text: string[] = []
				const at = rows.push([checked, ""]) - 1

				walk(child, ul, text)

				rows[at] = [checked, decodeHtmlEntities(text.join("")).trim()]
			} else if (child instanceof HTMLElement) {
				walk(child, child.tagName === "ul" ? child : ul, own)
			}
		}
	}

	walk(parse(html), undefined, undefined)

	return rows
}

function rows(html: string): [boolean, string][] {
	return checklistParser.parse(html).map(item => [item.checked, item.content])
}

describe("ChecklistParser", () => {
	it("should parse empty string to empty checklist", () => {
		const result = checklistParser.parse("")

		expect(result).toEqual([])
	})

	it("should parse single unchecked item", () => {
		const html = "<ul data-checked=\"false\"><li>Item 1</li></ul>"
		const result = checklistParser.parse(html)

		expect(result).toEqual([
			{
				id: expect.any(String),
				checked: false,
				content: "Item 1"
			}
		])
	})

	it("should parse single checked item", () => {
		const html = "<ul data-checked=\"true\"><li>Item 1</li></ul>"
		const result = checklistParser.parse(html)

		expect(result).toEqual([
			{
				id: expect.any(String),
				checked: true,
				content: "Item 1"
			}
		])
	})

	it("should stringify empty checklist to empty string", () => {
		const result = checklistParser.stringify([])

		expect(result).toBe("")
	})

	it("should stringify single unchecked item", () => {
		const checklist = [
			{
				id: "1",
				checked: false,
				content: "Item 1"
			}
		]

		const result = checklistParser.stringify(checklist)

		expect(result).toBe("<ul data-checked=\"false\"><li>Item 1</li></ul>")
	})

	it("should stringify single checked item", () => {
		const checklist = [
			{
				id: "1",
				checked: true,
				content: "Item 1"
			}
		]

		const result = checklistParser.stringify(checklist)

		expect(result).toBe("<ul data-checked=\"true\"><li>Item 1</li></ul>")
	})

	it("should parse and stringify multiple items correctly", () => {
		const html = "<ul data-checked=\"false\"><li>Item 1</li><li>Item 2</li></ul><ul data-checked=\"true\"><li>Item 3</li></ul>"
		const parsed = checklistParser.parse(html)
		const stringified = checklistParser.stringify(parsed)

		expect(stringified).toBe(html)
	})

	it("should handle items with empty content", () => {
		const html = "<ul data-checked=\"false\"><li><br></li><li>Item 2</li></ul>"
		const parsed = checklistParser.parse(html)

		expect(parsed).toEqual([
			{
				id: expect.any(String),
				checked: false,
				content: ""
			},
			{
				id: expect.any(String),
				checked: false,
				content: "Item 2"
			}
		])

		const stringified = checklistParser.stringify(parsed)

		expect(stringified).toBe(html)
	})

	it("should return empty checklist for malformed HTML", () => {
		const html = "<ul data-checked=\"false\">Item 1<li>Item 2"
		const parsed = checklistParser.parse(html)

		expect(parsed).toEqual([])
	})
})

describe("ChecklistParser — tag-like text losslessness", () => {
	// stringify -> (persist) -> parse must return the exact user text, even when it contains markup
	// characters. Without escaping, stringify writes the text raw into `<li>` and parse then strips or
	// splits it: "Fix <Header>" collapses to "Fix", and a literal `</li><li>` splits one row into two.
	// Each case here serializes a row, feeds the HTML back through the parser (the reopen path), and
	// asserts the content survives byte-for-byte.
	function roundTrip(content: string): string[] {
		const serialized = checklistParser.stringify([
			{
				id: "1",
				checked: false,
				content
			}
		])
		const parsed = checklistParser.parse(serialized)

		return parsed.map(item => item.content)
	}

	it("preserves a tag-like token instead of stripping it (\"Fix <Header>\" -> \"Fix\")", () => {
		expect(roundTrip("Fix <Header>")).toEqual(["Fix <Header>"])
	})

	it("preserves inline markup instead of unwrapping it (\"<b>bold</b>\" -> \"bold\")", () => {
		expect(roundTrip("<b>bold</b>")).toEqual(["<b>bold</b>"])
	})

	it("keeps a literal </li><li> payload as ONE row instead of splitting into two", () => {
		expect(roundTrip("a</li><li>b")).toEqual(["a</li><li>b"])
	})

	it("preserves a literally typed entity (a typed &lt; survives as &lt;, not decoded to <)", () => {
		expect(roundTrip("&lt;")).toEqual(["&lt;"])
	})

	it("preserves a bare ampersand", () => {
		expect(roundTrip("Tom & Jerry")).toEqual(["Tom & Jerry"])
	})
})

describe("ChecklistParser — rows older mobile builds stored unescaped", () => {
	function parseRow(rowHtml: string): string[] {
		return checklistParser.parse(`<ul data-checked="false"><li>${rowHtml}</li></ul>`).map(item => item.content)
	}

	// An "&" followed by a legacy entity name without its ";" must not expand ("cut&copy" -> "cut©").
	it.each(["cut&copy", "Save&note", "Check&register", "Get&quote", "left&center", "Issue&#42", "R&D", "AT&T", "Tom & Jerry"])(
		"reads %s back unchanged",
		raw => {
			expect(parseRow(raw)).toEqual([raw])
		}
	)

	it("keeps a legacy row's text when the list is next saved", () => {
		const saved = checklistParser.stringify(checklistParser.parse("<ul data-checked=\"false\"><li>cut&copy</li><li>Issue&#42</li></ul>"))

		expect(checklistParser.parse(saved).map(item => item.content)).toEqual(["cut&copy", "Issue&#42"])
	})

	it("still decodes every entity that ends in a semicolon", () => {
		expect(parseRow("Tom &amp; Jerry")).toEqual(["Tom & Jerry"])
		expect(parseRow("&amp;lt;")).toEqual(["&lt;"])
		expect(parseRow("&lt;Header&gt;")).toEqual(["<Header>"])
		expect(parseRow("a&nbsp;b")).toEqual(["a b"])
		expect(parseRow("it&#39;s it&#x27;s")).toEqual(["it's it's"])
		expect(parseRow("&quot;quoted&quot;")).toEqual(["\"quoted\""])
	})

	// The parser's tag pattern tries every way of splitting the text after such a "<" into attributes, which
	// took seconds to minutes for one sentence.
	it.each(["Fix the bug where count<limit fails on second try", "<li then do the thing now"])(
		"reads a row with a \"<\" that starts no tag quickly and as typed: %s",
		row => {
			const start = performance.now()
			const rows = checklistParser.parse(`<ul data-checked="false"><li>Milk</li><li>${row}</li></ul>`).map(item => item.content)

			expect(performance.now() - start).toBeLessThan(50)
			expect(rows).toEqual(["Milk", row])
		}
	)

	// Every shorter tag name and every split of the name's letters is a reading the parser's pattern backtracks into.
	it("reads a long word after a \"<\" in linear time", () => {
		const row = `x<${"a".repeat(20_000)}`
		const start = performance.now()
		const rows = checklistParser.parse(`<ul data-checked="false"><li>Milk</li><li>${row}</li></ul>`).map(item => item.content)

		expect(performance.now() - start).toBeLessThan(100)
		expect(rows).toEqual(["Milk", row])
	})
})

describe("ChecklistParser — rows read as node-html-better-parser reads the note", () => {
	// A rich note switched to a checklist keeps its Quill markup, which is parsed as it is stored.
	it("reads rows with attributes, plain lists and inline formatting as before", () => {
		const html =
			"<p>Intro</p><ul data-checked=\"true\"><li class=\"ql-indent-1\">Buy <strong>organic</strong> " +
			"<a href=\"https://example.com/?a=1&amp;b=2\" rel=\"noopener noreferrer\" target=\"_blank\">milk</a></li></ul>" +
			"<ul><li>bullet</li></ul>"

		expect(rows(html)).toEqual([
			[true, "Buy organic milk"],
			[false, "bullet"]
		])
	})

	// Rows older mobile builds stored unescaped. A tag the parser reads there must stay a tag: read as text, its close
	// tag would end the list, and the next save would drop every row after it.
	it.each([
		["Fix <Button onPress={() => go()}>Go</Button> spacing", "Fix  go()}>Go spacing"],
		["Set <View style={{flex: 1}}>x</View>", "Set x"],
		["Spread <Foo {...props}>x</Foo>", "Spread x"],
		["Link <a href=\"x\"target=\"_blank\">y</a> here", "Link y here"],
		["Pair <x,y>z</x> end", "Pair z end"],
		["Vue <button @click=\"save\">Save</button> ok", "Vue Save ok"],
		["JSX <Text style={\"bold\"}>label</Text> ok", "JSX label ok"],
		["Odd <a b=\"c>d</a> end", "Odd d end"],
		["Use Map<String,Integer> here", "Use Map here"],
		// Tags the parser's pattern reaches only by backtracking
		["x <a b=\">\" c< y", "x \" c< y"],
		["a<b'=b=/''>c", "ac"]
	])("reads %s as the parser does and keeps the rows after it", (row, read) => {
		const html = `<ul data-checked="false"><li>${row}</li><li>second row</li><li>third row</li></ul>`

		expect(rows(html)).toEqual([
			[false, read],
			[false, "second row"],
			[false, "third row"]
		])
		expect(rows(html)).toEqual(asStored(html))
	})

	it.each([
		"<ul data-checked=\"false\"><li>a<pre>hidden <li>no</li></PRE >b</li><li>c</li></ul>",
		"<ul data-checked=\"false\"><li>a<script>b</li><li>c</li></ul>",
		"<ul data-checked=\"false\"><li>call <constructor> here</li><li>next</li></ul>",
		// The parser drops all that follows a raw text element with no close tag, even a list
		"<ul data-checked=\"false\"><li>a</li></ul><pre> x<y </pre a=\"b\"><ul data-checked=\"true\"><li>b</li></ul>",
		"<ul data-checked=\"false\"><li>a</li></ul><constructor> x<y </constructor a=\"b\"><ul data-checked=\"true\"><li>b</li></ul>",
		"<ul data-checked=\"false\"><li>a <!-- <li>no --> b</li><li>c<!--d</li></ul>",
		// A closed element named for an inherited key keeps its content as text, also after a "<" that starts no tag
		"<ul data-checked=\"false\"><li>a<b c</li><li>x<i><toString>kept</toString></i>y</li></ul>",
		"<ul data-checked=\"false\"><li>count<limit</li><li>x<b><constructor>two words</constructor></b>y</li></ul>",
		// Stray close tags pop every element up to theirs, lists and rows included
		"<ul data-checked=\"false\"><li>Remove </div> from footer</li><li>Buy milk</li></ul>",
		"<ul data-checked=\"true\"><li>a</LI><li>b</li></ul>"
	])("reads %s as the parser does", html => {
		expect(rows(html)).toEqual(asStored(html))
	})

	it("keeps what an element named for an inherited key holds, after a \"<\" that starts no tag", () => {
		expect(rows("<ul data-checked=\"false\"><li>a<b c</li><li>x<i><toString>kept</toString></i>y</li></ul>")).toEqual([
			[false, "a<b c"],
			[false, "xkepty"]
		])
	})

	// Rows older mobile builds stored unescaped can hold a typed list, which the parser nests in the row.
	it.each([
		"<ul data-checked=\"false\"><li>Use <ol> for numbered steps</li><li>Buy milk</li></ul>",
		"<ul data-checked=\"false\"><li>Wrap nav links in <ul> element</li><li>Buy milk</li></ul>",
		"<ul data-checked=\"true\"><li>Replace <ul><li> with FlatList</li><li>next</li></ul>",
		"<ul data-checked=\"false\"><li>Use <ol><li> for steps</li><li>a</li><li>b</li></ul>",
		"<ul data-checked=\"false\"><li>a<ul><li>b</li></ul>"
	])("reads the typed list in %s as the parser does", html => {
		expect(rows(html)).toEqual(asStored(html))
	})

	// The first tag ends at its ">" only because its quote never closes, so nothing read after it may add one.
	it("keeps an unclosed quote unclosed when a later list is checked", () => {
		const html = "<ul data-checked=\"true\"><li><a b=\"c>x count<limit</li></ul><ul data-checked=true><li>y</li></ul>"

		expect(rows(html)).toEqual([
			[true, "x count<limit"],
			[true, "y"]
		])
		expect(rows(html)).toEqual(asStored(html))
	})

	// Pieces of what older builds and other editors stored, few enough per row for the parser to read quickly.
	it("reads random legacy markup as the parser does", () => {
		const pieces = [
			"a",
			" ",
			"x<y",
			"<",
			"</",
			">",
			"\"",
			"'",
			"=",
			"/",
			"&lt;",
			"&",
			"<b>",
			"</b>",
			"<br>",
			"<a b=\"c>",
			"<a b=\">\" c",
			"<i'=b=/''>",
			"<Foo {...p}>",
			"</Foo>",
			"<p @x=\"y\">",
			"<!--",
			"-->",
			"<pre>",
			"</pre >",
			"<li>",
			"</li>",
			"</ul>",
			"<ul data-checked=true>",
			"<LI>",
			"<i><constructor>k</constructor></i>",
			"<toString>",
			"<ol>",
			"</div>"
		]
		let seed = 1

		function random(): number {
			seed = (seed * 1103515245 + 12345) % 2147483648

			return seed / 2147483648
		}

		for (let note = 0; note < 2000; note++) {
			let html = ""

			for (let list = 0, lists = 1 + Math.floor(random() * 2); list < lists; list++) {
				html += random() < 0.5 ? "<ul data-checked=\"true\">" : "<ul data-checked=\"false\">"

				for (let row = 0, rowCount = 1 + Math.floor(random() * 3); row < rowCount; row++) {
					html += "<li>"

					for (let piece = 0, pieceCount = Math.floor(random() * 5); piece < pieceCount; piece++) {
						html += pieces[Math.floor(random() * pieces.length)]
					}

					html += "</li>"
				}

				html += "</ul>"
			}

			expect(rows(html), html).toEqual(asStored(html))
		}
	})
})

describe("ChecklistParser — rows nested in rows", () => {
	// No client writes nested lists. Read as the parser reads them, every row once under each list around it and with the
	// rows nested in it, a crafted note of them held cubic text, and the parser's queries recursed until the stack ran out.
	it("reads hundreds of nested lists quickly, each row once", () => {
		const html = `${"<ul data-checked=\"false\"><li>x".repeat(400)}${"</li></ul>".repeat(400)}`
		const start = performance.now()
		const read = rows(html)

		expect(performance.now() - start).toBeLessThan(100)
		expect(read).toHaveLength(400)
		expect(read).toEqual(readOnce(html))
	})

	it("reads rows nested past a few levels once each, under the nearest list, and previews the first of them", () => {
		const html = `<ul data-checked="true"><li>a${"<ul data-checked=\"false\"><li>b".repeat(12)}${"</li></ul>".repeat(12)}</li></ul>`

		expect(rows(html)).toEqual([[true, "a"], ...Array.from({ length: 12 }, () => [false, "b"])])
		expect(rows(html)).toEqual(readOnce(html))
		expect(checklistParser.firstNonEmptyContent(html)).toBe("a")
	})

	it("reads a row thousands of inline tags deep and keeps the rows around it", () => {
		const html = `<ul data-checked="false"><li>first</li><li>${"<b>x<i>x".repeat(1000)}</li><li>last</li></ul>`
		const start = performance.now()

		expect(rows(html)).toEqual([
			[false, "first"],
			[false, "x".repeat(2000)],
			[false, "last"]
		])
		expect(performance.now() - start).toBeLessThan(100)
	})

	// The parser's clean-up at the end moves each open element's children up one level at a time.
	it("reads a note that ends thousands of inline tags deep quickly", () => {
		const html = `<ul data-checked="false"><li>first</li><li>${"<b>x<i>x".repeat(16_000)}`
		const start = performance.now()

		expect(rows(html)).toEqual([[false, "first"]])
		expect(performance.now() - start).toBeLessThan(100)
	})

	// The parser's table lookup for "caller" inside "constructor" throws. It read the note as no rows, and the next note it
	// read started where the throw left its shared regex.
	it("reads on where the parser's own lookup throws, and reads the next note in full", () => {
		const html = "<ul data-checked=\"false\"><li>a</li><li>b<constructor>c</constructor><caller>d</li><li>e</li></ul>"

		expect(rows(html)).toEqual([
			[false, "a"],
			[false, "b"]
		])
		expect(rows("<ul data-checked=\"false\"><li>Milk</li><li>Eggs</li></ul>")).toEqual([
			[false, "Milk"],
			[false, "Eggs"]
		])
	})
})

describe("ChecklistParser.firstNonEmptyContent", () => {
	// The preview reads rows without the parser, so it must land on the row the editor shows first.
	it.each([
		["<ul data-checked=\"false\"><li><br></li><li>Milk</li></ul>", "Milk"],
		[
			"<ul data-checked=\"true\"><li>Fix the bug where count<limit fails on second try</li></ul>",
			"Fix the bug where count<limit fails on second try"
		],
		["<ul data-checked=\"false\"><li>cut&copy</li></ul>", "cut&copy"],
		["<ul data-checked=\"false\"><li>Fix <Header></li></ul>", "Fix"],
		["<ul data-checked=\"false\"><li>Fix <Button onPress={() => go()}>Go</Button> spacing</li></ul>", "Fix  go()}>Go spacing"],
		["<ul data-checked=\"false\"><li>Vue <button @click=\"save\">Save</button> ok</li></ul>", "Vue Save ok"],
		["<ul data-checked=\"false\"><li><br></li><li>x <a b=\">\" c< y</li></ul>", "x \" c< y"],
		["<ul data-checked=\"false\"><li>a<pre><li>no</li></pre>b</li></ul>", "ab"],
		["<ul data-checked=\"false\"><li><!-- x --></li><li>a <!-- c --> b</li></ul>", "a  b"],
		["<ul data-checked=\"false\"><li>x<!--y</li></ul>", "x<!--y"],
		["<ul data-checked=\"false\"><li>a<li/>b</li></ul>", "ab"],
		[
			"<p>Intro</p><ol><li>Numbered</li></ol><ul data-checked=\"true\"><li class=\"ql-indent-1\">Buy <strong>organic</strong> " +
				"<a href=\"https://example.com/?a=1&amp;b=2\" rel=\"noopener noreferrer\" target=\"_blank\">milk</a></li></ul>",
			"Buy organic milk"
		],
		["<ol><li>Numbered</li></ol>", ""],
		["<ul data-checked=\"false\"><li>still open", ""]
	])("reads %s as the first row the parser returns", (html, first) => {
		expect(checklistParser.firstNonEmptyContent(html)).toBe(first)
		expect(checklistParser.parse(html).find(item => item.content.length > 0)?.content ?? "").toBe(first)
	})

	// Rows older mobile builds stored unescaped: a typed list nests in the row, and a stray close tag ends the list.
	it.each([
		["<ul data-checked=\"false\"><li>Use <ol> here</li><li>Buy milk</li></ul>", "Use  here"],
		["<ul data-checked=\"false\"><li>Wrap nav links in <ul> element</li><li>Buy milk</li></ul>", "Wrap nav links in  element"],
		["<ul data-checked=\"false\"><li>Remove </div> from footer</li><li>Buy milk</li></ul>", "Remove"],
		["<ul data-checked=\"false\"><li><ol></li><li>Buy milk</li></ul>", "Buy milk"],
		["<ul data-checked=\"false\"><li><br><ul><li>b</li></ul></li></ul>", "b"],
		["<ul data-checked=\"false\"><li>a<ul><li>b</li></ul>", "b"],
		["<ul data-checked=\"false\"><li>x<i><constructor>kept</constructor></i>y</li></ul>", "xkepty"],
		// A list inside another element stays only if it closes
		["<div><ul data-checked=\"true\"><li>b</li></ul>", "b"],
		["<div><ul data-checked=\"true\"><li>b</li>", ""]
	])("reads %s as the first row the parser itself returns", (html, first) => {
		expect(checklistParser.firstNonEmptyContent(html)).toBe(first)
		expect(checklistParser.parse(html).find(item => item.content.length > 0)?.content ?? "").toBe(first)
		expect(asStored(html).find(([, content]) => content.length > 0)?.[1] ?? "").toBe(first)
	})
})
