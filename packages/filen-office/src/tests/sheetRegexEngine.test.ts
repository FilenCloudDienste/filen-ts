import { describe, expect, it } from "vitest"
import { Regex, RegexBudgetError, RegexSyntaxError, RegexUnsupportedError } from "../core/sheet/formula/regex/index"
import { budget } from "./timing"

// The linear-time PCRE2 engine behind REGEXTEST, REGEXEXTRACT and REGEXREPLACE. Expected values are PCRE2's
// (pcre2pattern(3) and pcre2api(3) on pcre2project.github.io describe each construct).

function compile(pattern: string, caseless = false): Regex {
	return Regex.compile(pattern, { caseless, captures: true })
}

// The first match and its groups (undefined for a group that took no part), or null.
function exec(pattern: string, text: string, caseless = false): (string | undefined)[] | null {
	const regex = compile(pattern, caseless)
	const slots = regex.exec(text)

	if (slots === null) return null

	const out: (string | undefined)[] = []

	for (let group = 0; group <= regex.groups; group++) {
		const start = slots[group * 2] ?? -1
		const end = slots[group * 2 + 1] ?? -1

		out.push(start < 0 ? undefined : text.slice(start, end))
	}

	return out
}

function all(pattern: string, text: string): string[] {
	return [...compile(pattern).matches(text)].map(slots => text.slice(slots[0], slots[1]))
}

function kind(pattern: string): "ok" | "syntax" | "unsupported" {
	try {
		compile(pattern)

		return "ok"
	} catch (error) {
		if (error instanceof RegexUnsupportedError) return "unsupported"
		if (error instanceof RegexSyntaxError) return "syntax"

		throw error
	}
}

describe("regex engine: matching", () => {
	it("matches literals, classes, dot and escapes", () => {
		expect(exec("b+", "aabbbc")).toEqual(["bbb"])
		expect(exec("[0-9]+", "ab 123 45")).toEqual(["123"])
		expect(exec("[^a-c]", "abcd")).toEqual(["d"])
		expect(exec("a.c", "a\nc abc")).toEqual(["abc"])
		expect(exec("(?s)a.c", "a\nc")).toEqual(["a\nc"])
		expect(exec("\\d\\s\\w", "x 1 a")).toEqual(["1 a"])
		expect(exec("\\D+", "12ab3")).toEqual(["ab"])
		expect(exec("\\W", "ab-c")).toEqual(["-"])
		expect(exec("\\S+", "  xy ")).toEqual(["xy"])
		expect(exec("\\x41\\x{42}\\103\\o{104}\\t", "ABCD\t")).toEqual(["ABCD\t"])
		expect(exec("\\cA", "\u0001")).toEqual(["\u0001"])
		expect(exec("\\Qa.b*\\E+", "a.b**")).toEqual(["a.b**"])
		expect(exec("[\\Q]\\E]", "]")).toEqual(["]"])
		expect(exec("\\.\\*\\$", "x.*$")).toEqual([".*$"])
		expect(exec("[]a]+", "]a]")).toEqual(["]a]"])
		expect(exec("[^]a]", "]ab")).toEqual(["b"])
		expect(exec("[a-]+", "-a-")).toEqual(["-a-"])
		expect(exec("\\h+\\v", " \t\n")).toEqual([" \t\n"])
		expect(exec("\\N+", "ab\nc")).toEqual(["ab"])
		expect(exec("a{", "a{")).toEqual(["a{"])
		expect(exec("[\\8]", "8")).toEqual(["8"])
		expect(exec("\\100", "@")).toEqual(["@"])
		expect(exec("\\N{2}", "abc")).toEqual(["ab"])
	})

	it("reads POSIX classes inside a class", () => {
		expect(exec("[[:alpha:]]+", "12abC3")).toEqual(["abC"])
		expect(exec("[[:^digit:]]+", "12ab3")).toEqual(["ab"])
		expect(exec("[[:xdigit:][:space:]]+", "zz 0aF g")).toEqual([" 0aF "])
		expect(exec("[[:upper:]]+", "abCD", true)).toEqual(["abCD"])
	})

	it("counts quantifiers greedy, lazy and bounded", () => {
		expect(exec("a{2,3}", "aaaa")).toEqual(["aaa"])
		expect(exec("a{2,3}?", "aaaa")).toEqual(["aa"])
		expect(exec("a{2}", "aaaa")).toEqual(["aa"])
		expect(exec("a{2,}", "aaaa")).toEqual(["aaaa"])
		expect(exec("a+?", "aaa")).toEqual(["a"])
		expect(exec("a*?b", "aab")).toEqual(["aab"])
		expect(exec("<.+>", "<a><b>")).toEqual(["<a><b>"])
		expect(exec("<.+?>", "<a><b>")).toEqual(["<a>"])
		expect(exec("(?U)<.+>", "<a><b>")).toEqual(["<a>"])
		expect(exec("(?U)<.+?>", "<a><b>")).toEqual(["<a><b>"])
		expect(exec("a{0}b", "ab")).toEqual(["b"])
	})

	it("takes the leftmost-first alternative, as a backtracking matcher does (not the longest)", () => {
		expect(exec("a|ab", "ab")).toEqual(["a"])
		expect(exec("ab|a", "ab")).toEqual(["ab"])
		expect(exec("(a|ab)(c|bcd)", "abcd")).toEqual(["abcd", "a", "bcd"])
		expect(exec("(a+)(a*)", "aaa")).toEqual(["aaa", "aaa", ""])
		expect(exec("(a+?)(a*)", "aaa")).toEqual(["aaa", "a", "aa"])
		expect(exec("x*", "axx")).toEqual([""])
	})

	it("matches a loop whose body matches nothing as its last choice as PCRE2 does, but holds its captures", () => {
		// PCRE2 ends a loop at an iteration that matches nothing and keeps that iteration's captures: (a|)* over "aa"
		// is "aa" with group 1 "".
		const extent = (pattern: string, text: string): string | undefined => {
			const slots = Regex.compile(pattern).exec(text)

			return slots === null ? undefined : text.slice(slots[0], slots[1])
		}

		expect(extent("(a|)*", "aa")).toBe("aa")
		expect(extent("(a*)*", "b")).toBe("")
		expect(extent("(a*)+b", "aab")).toBe("aab")
		expect(extent("(?:a?b?)*c", "abbc")).toBe("abbc")
		expect(kind("(a|)*")).toBe("unsupported")
		expect(kind("(?:a|)*")).toBe("ok")
	})

	it("holds a loop whose body can match nothing before matching something", () => {
		// PCRE2: (?:a||b)* over "ab" is "a" (the second iteration takes the empty branch and ends the loop).
		expect(() => Regex.compile("(?:a||b)*")).toThrow(RegexUnsupportedError)
		expect(() => Regex.compile("(|a)*")).toThrow(RegexUnsupportedError)
		expect(() => Regex.compile("(?:a*?)+")).toThrow(RegexUnsupportedError)
		expect(() => Regex.compile("(?:\\b|a)*")).toThrow(RegexUnsupportedError)
	})

	it("keeps the last iteration's capture and leaves a group outside the match unset", () => {
		expect(exec("(?:(a)|b)+", "ab")).toEqual(["ab", "a"])
		expect(exec("(a)|(b)", "b")).toEqual(["b", undefined, "b"])
		expect(exec("(\\w)+", "abc")).toEqual(["abc", "c"])
		expect(exec("(a)?b", "b")).toEqual(["b", undefined])
	})

	it("numbers named and unnamed groups in order and skips non-capturing ones", () => {
		const regex = compile("(?<y>\\d{4})-(?:x)?(?P<m>\\d\\d)-(?'d'\\d\\d)(n)")

		expect(regex.groups).toBe(4)
		expect([...regex.parsed.names]).toEqual([
			["y", 1],
			["m", 2],
			["d", 3]
		])
		expect(exec("(?n)(a)(?<b>b)", "ab")).toEqual(["ab", "b"])
	})

	it("anchors ^ $ \\A \\z \\Z \\b \\B \\G as PCRE2 does", () => {
		expect(exec("^b", "ab")).toBeNull()
		expect(exec("(?m)^b", "a\nb")).toEqual(["b"])
		expect(exec("(?m)^", "a\n")?.[0]).toBe("")
		expect(all("(?m)^", "a\n")).toEqual([""])
		expect(exec("a$", "a\n")).toEqual(["a"])
		expect(exec("a$", "a\nb")).toBeNull()
		expect(exec("(?m)a$", "a\nb")).toEqual(["a"])
		expect(exec("a\\Z", "a\n")).toEqual(["a"])
		expect(exec("a\\z", "a\n")).toBeNull()
		expect(exec("\\Aa", "ba")).toBeNull()
		expect(exec("\\bcat\\b", "concat cat")).toEqual(["cat"])
		expect(compile("\\bcat\\b").exec("concat cat")?.[0]).toBe(7)
		expect(exec("\\Bat", "at cat")).toEqual(["at"])
		expect(all("\\Ga", "aab")).toEqual(["a", "a"])
	})

	it("scopes inline options to their group and applies (?x) and (?#)", () => {
		expect(exec("a(?i)b", "aB")).toEqual(["aB"])
		expect(exec("a(?i)b", "AB")).toBeNull()
		expect(exec("(a(?i)b)c", "aBC")).toBeNull()
		expect(exec("(?i:a)b", "Ab")).toEqual(["Ab"])
		expect(exec("(?i)a(?-i)b", "Ab")).toEqual(["Ab"])
		expect(exec("(?i)a(?-i)b", "AB")).toBeNull()
		expect(exec("(a(?i)b|c)", "C")).toEqual(["C", "C"])
		expect(exec("(?x) a b # comment\n c", "abc")).toEqual(["abc"])
		expect(exec("(?x)[ ]", " ")).toEqual([" "])
		expect(exec("(?xx)[a b]+", "ab ")).toEqual(["ab"])
		expect(exec("a(?#note)b", "ab")).toEqual(["ab"])
		expect(exec("(?i)ab(?^)c", "ABc")).toEqual(["ABc"])
	})

	it("matches by code point, a surrogate pair as one character", () => {
		expect(exec("^.$", "😀")).toEqual(["😀"])
		expect(exec("[😀-😂]+", "x😁😂y")).toEqual(["😁😂"])
		expect(exec("\\x{1F600}", "😀")).toEqual(["😀"])
		expect(all(".", "a😀")).toEqual(["a", "😀"])
		expect(all("", "😀")).toEqual(["", ""])
	})

	it("folds case by Unicode simple case folding", () => {
		expect(exec("straße", "STRAẞE", true)).toEqual(["STRAẞE"])
		expect(exec("k", "K", true)).toEqual(["K"])
		expect(exec("σ+", "Σσς", true)).toEqual(["Σσς"])
		expect(exec("s", "ſ", true)).toEqual(["ſ"])
		expect(exec("[a-z]+", "ÀBC", true)).toEqual(["BC"])
		expect(exec("[à-ÿ]+", "ÀÉ", true)).toEqual(["ÀÉ"])
		expect(exec("i", "ı", true)).toBeNull()
		expect(exec("i", "İ", true)).toBeNull()
		expect(exec("\\w", "K", true)).toBeNull()
		expect(exec("[^k]", "KK", true)).toBeNull()
		expect(exec("ΑΒΓ", "αβγ", true)).toEqual(["αβγ"])
		expect(exec("Ab", "aB", false)).toBeNull()
	})

	it("finds every match the way PCRE2's global matching does", () => {
		expect(all("[A-Z][a-z]+", "DylanWilliams")).toEqual(["Dylan", "Williams"])
		expect(all("x*", "axb")).toEqual(["", "x", "", ""])
		expect(all("a|", "ab")).toEqual(["a", "", ""])
		expect(all("\\d+", "a1b22c333")).toEqual(["1", "22", "333"])
	})

	it("runs a possessive quantifier as a greedy one where that matches the same", () => {
		expect(exec("a++b", "aab")).toEqual(["aab"])
		expect(exec("\\d*+$", "x12")).toEqual(["12"])
		expect(exec("a{2}+", "aaa")).toEqual(["aa"])
		expect(exec("x[a-c]*+", "xabc")).toEqual(["xabc"])
	})
})

describe("regex engine: patterns PCRE2 rejects", () => {
	it.each([
		"(a",
		"a)",
		"[a",
		"*a",
		"a|+",
		"a{3,2}",
		"a{70000}",
		"\\",
		"\\y",
		"\\i",
		"[z-a]",
		"[\\d-z]",
		"[a-\\w]",
		"[[:foo:]]",
		"[[.a.]]",
		"(?<1a>x)",
		"(?<a>x)(?<a>y)",
		"(?z)",
		"\\x{110000}",
		"\\x{D800}",
		"\\o{9}",
		"\\c",
		"a**",
		"a+??",
		"a{2}{3}",
		"\\b+",
		"^*",
		"$+",
		"(?i)*",
		"[\\B]",
		"(?#",
		"(".repeat(251) + ")".repeat(251)
	])("rejects %j", pattern => {
		expect(kind(pattern)).toBe("syntax")
	})

	it("takes duplicate names under (?J) and 250 nested groups", () => {
		expect(kind("(?J)(?<a>x)|(?<a>y)")).toBe("ok")
		expect(kind("(".repeat(250) + ")".repeat(250))).toBe("ok")
	})
})

describe("regex engine: constructs held, not run", () => {
	it.each([
		["backreference", "(a)\\1"],
		["named backreference", "(?<n>a)\\k<n>"],
		["\\g backreference", "(a)\\g1"],
		["(?P=name)", "(?P<n>a)(?P=n)"],
		["lookahead", "a(?=b)"],
		["negative lookahead", "a(?!b)"],
		["lookbehind", "(?<=a)b"],
		["negative lookbehind", "(?<!a)b"],
		["atomic group", "(?>a+)b"],
		["recursion", "a(?R)?b"],
		["subroutine call", "(a)(?1)"],
		["relative subroutine call", "(a)(?-1)"],
		["named subroutine call", "(?<n>a)(?&n)"],
		["conditional", "(a)?(?(1)b|c)"],
		["branch reset", "(?|(a)|(b))"],
		["callout", "a(?C1)b"],
		["verb", "(*UTF)a"],
		["backtracking verb", "a(*SKIP)b"],
		["Unicode property", "\\p{L}"],
		["Unicode property in a class", "[\\p{Lu}]"],
		["extended grapheme", "\\X"],
		["newline sequence", "\\R"],
		["match reset", "a\\Kb"],
		["single code unit", "\\C"],
		["\\u escape", "\\u0041"],
		["\\N{name}", "\\N{U+0041}"],
		["possessive quantifier followed by an overlapping item", "a*+a"],
		["possessive quantifier on a group", "(ab)*+c"],
		["newer quantifier form", "a{,3}"],
		["quantifier after a comment", "a(?#x)*"],
		["quantifier after an empty quote", "a\\Q\\E*"],
		["too large a program", "(?:[a-z]{1000}){20}"]
	])("holds a %s", (_name, pattern) => {
		expect(kind(pattern)).toBe("unsupported")
	})
})

describe("regex engine: linear time", () => {
	const text = "a".repeat(30_000)

	function timed(work: () => void): number {
		const start = Date.now()

		work()

		return Date.now() - start
	}

	it.each([
		["(a+)+$", text + "!"],
		["(a|aa)*b", text],
		["(.*a){20}", text],
		["(?:a*)*b", text],
		["(?:a|a)*c", text],
		["^(\\w+\\s?)*$", "a ".repeat(15_000) + "!"],
		["(x+x+)+y", "x".repeat(30_000)]
	])("runs %j over 30,000 characters in linear time", (pattern, subject) => {
		const regex = compile(pattern)
		const elapsed = timed(() => {
			regex.exec(subject)
		})

		expect(elapsed).toBeLessThan(budget(2000))
	})

	it("finds every match of a pathological pattern over 30,000 characters in linear time", () => {
		const regex = compile("(a|aa)*?a")
		const elapsed = timed(() => {
			expect([...regex.matches(text)]).toHaveLength(30_000)
		})

		expect(elapsed).toBeLessThan(budget(2000))
	})

	it("scales linearly with the text", () => {
		const regex = compile("(a|aa)*b")

		regex.exec("a".repeat(2_000))

		const small = timed(() => {
			for (let round = 0; round < 5; round++) regex.exec("a".repeat(3_000))
		})
		const large = timed(() => {
			for (let round = 0; round < 5; round++) regex.exec("a".repeat(30_000))
		})

		// Ten times the text: about ten times the time, far from the hundred times a quadratic search would take.
		expect(large).toBeLessThan(Math.max(budget(50), small * 30))
	})

	it("passes over text that cannot start or hold a match, caseless letters too, finding the same matches", () => {
		const regex = compile("(?i)SHIPPED.*TOTAL.*XYZ")

		expect(regex.test(`${"x".repeat(20)}xyz shipped, total`)).toBe(false)
		expect(regex.test("shipped, Total, XyZ")).toBe(true)
		expect(regex.test(`SHIPPED${"-".repeat(20000)}total${"-".repeat(10000)}xyz`)).toBe(true)
		expect(compile("(?i)ab|cd").exec("xxABxxCd")?.[0]).toBe(2)
		expect([...compile("(?i)k").matches("ak\u212aK")].map(slots => slots[0])).toEqual([1, 2, 3])
	})

	it("stops a search over its step budget", () => {
		const regex = compile("(?:a*a*a*a*c)|a")
		const subject = "a".repeat(30_000)

		expect(() => [...regex.matches(subject)]).toThrow(RegexUnsupportedError)
	})

	it("stops a search whose threads take no steps but copy captures or follow alternatives at every position", () => {
		const subject = "a".repeat(32_767)
		const groups = compile("()".repeat(706))
		const alternatives = Regex.compile("|".repeat(4_999))

		expect(() => [...groups.matches(subject)]).toThrow(RegexBudgetError)
		expect(() => [...alternatives.matches(subject)]).toThrow(RegexBudgetError)
	})

	it("refuses a program whose nested repeats count past any number, repeated no times too", () => {
		const nested = `${"(?:".repeat(65)}a{65535}${"){65535}".repeat(65)}`

		for (const pattern of [nested, `(?:${nested}){0}`, `(?:${"(?:".repeat(64)}a{65535}${"){65535}".repeat(64)}){0}`]) {
			expect(kind(pattern)).toBe("unsupported")
			expect(() => Regex.compile(pattern)).toThrow(RegexUnsupportedError)
		}
	})
})
