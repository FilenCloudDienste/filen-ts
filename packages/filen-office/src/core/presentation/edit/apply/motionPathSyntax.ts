// Whether a motion path (ECMA-376 §19.5.4 p:animMotion@path) is only commands and numbers: the language of
//   /^[\s,]*(?:(?:[MLCZEmlcze]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)[\s,]*)+$/
// decided in time linear in the path. The expression lets a digit run split into numbers anywhere, which a
// backtracking engine tries exponentially often before refusing a path that does not end well; here, from the end
// back, each position is marked when the rest splits into tokens, and a number's ends are ranges of positions, so
// each is answered from a running count.
export function motionPathSyntax(path: string): boolean {
	const n = path.length
	const ok = new Uint8Array(n + 1)
	// count[i]: how many positions from i on are marked.
	const count = new Int32Array(n + 2)
	// digitEnd[i]: the first position at or after i that is not a digit.
	const digitEnd = new Int32Array(n + 1)
	let token = false

	digitEnd[n] = n

	for (let i = n - 1; i >= 0; i--) digitEnd[i] = isDigit(path.charCodeAt(i)) ? (digitEnd[i + 1] as number) : i

	const digitsFrom = (i: number): number => (i >= n ? n : (digitEnd[i] as number))
	const marked = (from: number, to: number): boolean => from <= to && (count[from] as number) - (count[to + 1] as number) > 0

	ok[n] = 1
	count[n] = 1

	for (let i = n - 1; i >= 0; i--) {
		const code = path.charCodeAt(i)
		let valid: boolean

		if (isSeparator(path[i] as string) || COMMANDS.has(code)) valid = ok[i + 1] === 1
		else valid = numberEndsMarked(path, i, digitsFrom, marked)

		if (!isSeparator(path[i] as string)) token = true

		ok[i] = valid ? 1 : 0
		count[i] = (count[i + 1] as number) + (ok[i] as number)
	}

	return token && ok[0] === 1
}

// Whether a number starting at `i` ends where the rest is marked: its mantissa (digits, a point, digits; or a point and
// digits) may end anywhere after its first digit, and an exponent follows only its longest mantissa (the next
// character of any shorter one is a digit or the point).
function numberEndsMarked(
	path: string,
	i: number,
	digitsFrom: (i: number) => number,
	marked: (from: number, to: number) => boolean
): boolean {
	const code = path.charCodeAt(i)
	const at = code === PLUS || code === MINUS ? i + 1 : i
	const digits = digitsFrom(at)
	const mantissas: (readonly [number, number])[] = []

	if (digits > at) {
		mantissas.push([at + 1, digits])

		if (path.charCodeAt(digits) === POINT) mantissas.push([digits + 1, digitsFrom(digits + 1)])
	} else if (path.charCodeAt(at) === POINT && isDigit(path.charCodeAt(at + 1))) mantissas.push([at + 2, digitsFrom(at + 1)])

	for (const [from, to] of mantissas) {
		if (marked(from, to)) return true

		const e = path.charCodeAt(to)

		if (e !== LOWER_E && e !== UPPER_E) continue

		const sign = path.charCodeAt(to + 1)
		const exponent = sign === PLUS || sign === MINUS ? to + 2 : to + 1
		const end = digitsFrom(exponent)

		if (end > exponent && marked(exponent + 1, end)) return true
	}

	return false
}

const COMMANDS: ReadonlySet<number> = new Set([..."MLCZEmlcze"].map(character => character.charCodeAt(0)))
const PLUS = 0x2b
const MINUS = 0x2d
const POINT = 0x2e
const LOWER_E = 0x65
const UPPER_E = 0x45

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39
}

// \s (as the expression reads it, with the u flag) or a comma.
function isSeparator(character: string): boolean {
	return character === "," || /\s/u.test(character)
}
