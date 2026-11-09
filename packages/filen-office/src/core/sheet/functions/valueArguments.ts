// The arguments of worksheet functions that take one value: a range given to one is read at the formula's own row or
// column in a formula written before dynamic arrays, which Excel shows with @ (support.microsoft.com "Implicit
// intersection operator: @"). Microsoft documents no argument classes, so each function's are decided here, every one
// with its source; a function not listed takes no @ anywhere (as the file stored it).
//
// Each entry: the name, the classes of the first seven arguments (v one value, x a range or an array), and for a function
// whose last arguments repeat, the index after the listed ones and how many repeat (LibreOffice's GetParameterType:
// nMinParams, nRepeatLast).

// LibreOffice 7.5's parameter class table, the standing tie-break (sc/source/core/tool/parclass.cxx, pRawData), by the
// OOXML English names (formula/inc/core_resource.hrc): Value is one value. N and T are left out: the table's own comment
// says Excel reads their argument as a reference. IF, IFERROR, NOT, CHOOSE and every other Array, Reference or
// ForceArray argument take no @.
const LIBREOFFICE =
	"AGGREGATE:vvxxxxx:3:1 AVERAGEIF:xvxxxxx AVERAGEIFS:xxvxvxv:3:2 CELL:vxxxxxx COUNTIF:xvxxxxx " +
	"COUNTIFS:xvxvxvx:2:2 FORECAST:vxxxxxx FORECAST.ETS:xxxvvvx FORECAST.ETS.CONFINT:xxxvvvv " +
	"FORECAST.ETS.SEASONALITY:xxvvxxx FORECAST.ETS.STAT:xxxvvvx GROWTH:xxxvxxx HLOOKUP:vxvvxxx " +
	"INDEX:xvvvxxx INDIRECT:vvxxxxx IRR:xvxxxxx LARGE:xvxxxxx LINEST:xxvvxxx LOGEST:xxvvxxx " +
	"LOOKUP:vxxxxxx MATCH:vxvxxxx MAXIFS:xxvxvxv:3:2 MINIFS:xxvxvxv:3:2 MIRR:xvvxxxx NETWORKDAYS:vvxxxxx " +
	"NETWORKDAYS.INTL:vvvxxxx NPV:vxxxxxx:2:1 OFFSET:xvvvvxx PERCENTILE:xvxxxxx PERCENTILE.EXC:xvxxxxx " +
	"PERCENTILE.INC:xvxxxxx PERCENTRANK:xvvxxxx PERCENTRANK.EXC:xvvxxxx PERCENTRANK.INC:xvvxxxx " +
	"PROB:xxvvxxx QUARTILE:xvxxxxx QUARTILE.EXC:xvxxxxx QUARTILE.INC:xvxxxxx RANK:vxvxxxx " +
	"RANK.AVG:vxvxxxx RANK.EQ:vxvxxxx SMALL:xvxxxxx SUBTOTAL:vxxxxxx:2:1 SUMIF:xvxxxxx SUMIFS:xxvxvxv:3:2 " +
	"TEXTJOIN:xvxxxxx:3:1 TREND:xxxvxxx TRIMMEAN:xvxxxxx TTEST:xxvvxxx VLOOKUP:vxvvxxx " +
	"WORKDAY.INTL:vvvxxxx Z.TEST:xvvxxxx ZTEST:xvvxxxx"

// Functions Excel 2010 renamed, which the table classes only under their compatibility name (support.microsoft.com
// "Compatibility functions"): T.TEST as TTEST, F.TEST as FTEST (no value argument), FORECAST.LINEAR as FORECAST.
const RENAMED = "T.TEST:xxvvxxx FORECAST.LINEAR:vxxxxxx"

// Functions the table does not class, decided from their pages on support.microsoft.com: each argument is a number,
// text, a date or a logical value (ABS's number, LEN's text, NORM.DIST's x and mean, ISBLANK's value, CONCATENATE's
// texts, repeated), or for GETPIVOTDATA the data field and the field and item pairs, pivot_table being a reference.
// Left out, taking no @: CHISQ.TEST and CHITEST (actual_range and expected_range), TYPE (gives 64 for an array, so it
// reads one whole), IFS and SWITCH (conditions and results, as LibreOffice classes IF and CHOOSE).
const DOCUMENTED =
	"ABS:vvvvvvv ACOS:vvvvvvv ACOSH:vvvvvvv ACOT:vvvvvvv ACOTH:vvvvvvv ADDRESS:vvvvvvv ARABIC:vvvvvvv " +
	"ASC:vvvvvvv ASIN:vvvvvvv ASINH:vvvvvvv ATAN:vvvvvvv ATAN2:vvvvvvv ATANH:vvvvvvv BAHTTEXT:vvvvvvv " +
	"BASE:vvvvvvv BETA.DIST:vvvvvvv BETA.INV:vvvvvvv BETADIST:vvvvvvv BETAINV:vvvvvvv BINOM.DIST:vvvvvvv " +
	"BINOM.INV:vvvvvvv BINOMDIST:vvvvvvv BITAND:vvvvvvv BITLSHIFT:vvvvvvv BITOR:vvvvvvv BITRSHIFT:vvvvvvv " +
	"BITXOR:vvvvvvv CEILING:vvvvvvv CEILING.MATH:vvvvvvv CEILING.PRECISE:vvvvvvv CHAR:vvvvvvv " +
	"CHIDIST:vvvvvvv CHIINV:vvvvvvv CHISQ.DIST:vvvvvvv CHISQ.DIST.RT:vvvvvvv CHISQ.INV:vvvvvvv " +
	"CHISQ.INV.RT:vvvvvvv CLEAN:vvvvvvv CODE:vvvvvvv COMBIN:vvvvvvv COMBINA:vvvvvvv " +
	"CONCATENATE:vvvvvvv:1:1 CONFIDENCE:vvvvvvv CONFIDENCE.NORM:vvvvvvv CONFIDENCE.T:vvvvvvv COS:vvvvvvv " +
	"COSH:vvvvvvv COT:vvvvvvv COTH:vvvvvvv CRITBINOM:vvvvvvv CSC:vvvvvvv CSCH:vvvvvvv CUMIPMT:vvvvvvv " +
	"CUMPRINC:vvvvvvv DATE:vvvvvvv DATEDIF:vvvvvvv DATEVALUE:vvvvvvv DAY:vvvvvvv DAYS:vvvvvvv " +
	"DAYS360:vvvvvvv DB:vvvvvvv DDB:vvvvvvv DECIMAL:vvvvvvv DEGREES:vvvvvvv DOLLAR:vvvvvvv EFFECT:vvvvvvv " +
	"ENCODEURL:vvvvvvv ERF.PRECISE:vvvvvvv ERFC.PRECISE:vvvvvvv ERROR.TYPE:vvvvvvv EUROCONVERT:vvvvvvv " +
	"EVEN:vvvvvvv EXACT:vvvvvvv EXP:vvvvvvv EXPON.DIST:vvvvvvv EXPONDIST:vvvvvvv F.DIST:vvvvvvv " +
	"F.DIST.RT:vvvvvvv F.INV:vvvvvvv F.INV.RT:vvvvvvv FACT:vvvvvvv FDIST:vvvvvvv FILTERXML:vvvvvvv " +
	"FIND:vvvvvvv FINDB:vvvvvvv FINV:vvvvvvv FISHER:vvvvvvv FISHERINV:vvvvvvv FIXED:vvvvvvv FLOOR:vvvvvvv " +
	"FLOOR.MATH:vvvvvvv FLOOR.PRECISE:vvvvvvv FV:vvvvvvv GAMMA:vvvvvvv GAMMA.DIST:vvvvvvv " +
	"GAMMA.INV:vvvvvvv GAMMADIST:vvvvvvv GAMMAINV:vvvvvvv GAMMALN:vvvvvvv GAMMALN.PRECISE:vvvvvvv " +
	"GAUSS:vvvvvvv GETPIVOTDATA:vxvvvvv:2:1 HOUR:vvvvvvv HYPERLINK:vvvvvvv HYPGEOM.DIST:vvvvvvv " +
	"HYPGEOMDIST:vvvvvvv INFO:vvvvvvv INT:vvvvvvv IPMT:vvvvvvv ISBLANK:vvvvvvv ISERR:vvvvvvv " +
	"ISERROR:vvvvvvv ISEVEN:vvvvvvv ISLOGICAL:vvvvvvv ISNA:vvvvvvv ISNONTEXT:vvvvvvv ISNUMBER:vvvvvvv " +
	"ISO.CEILING:vvvvvvv ISODD:vvvvvvv ISOWEEKNUM:vvvvvvv ISPMT:vvvvvvv ISTEXT:vvvvvvv JIS:vvvvvvv " +
	"LEFT:vvvvvvv LEFTB:vvvvvvv LEN:vvvvvvv LENB:vvvvvvv LN:vvvvvvv LOG:vvvvvvv LOG10:vvvvvvv " +
	"LOGINV:vvvvvvv LOGNORM.DIST:vvvvvvv LOGNORM.INV:vvvvvvv LOGNORMDIST:vvvvvvv LOWER:vvvvvvv " +
	"MID:vvvvvvv MIDB:vvvvvvv MINUTE:vvvvvvv MOD:vvvvvvv MONTH:vvvvvvv MUNIT:vvvvvvv " +
	"NEGBINOM.DIST:vvvvvvv NEGBINOMDIST:vvvvvvv NOMINAL:vvvvvvv NORM.DIST:vvvvvvv NORM.INV:vvvvvvv " +
	"NORM.S.DIST:vvvvvvv NORM.S.INV:vvvvvvv NORMDIST:vvvvvvv NORMINV:vvvvvvv NORMSDIST:vvvvvvv " +
	"NORMSINV:vvvvvvv NPER:vvvvvvv NUMBERVALUE:vvvvvvv ODD:vvvvvvv PDURATION:vvvvvvv PERMUT:vvvvvvv " +
	"PERMUTATIONA:vvvvvvv PHI:vvvvvvv PMT:vvvvvvv POISSON:vvvvvvv POISSON.DIST:vvvvvvv PPMT:vvvvvvv " +
	"PROPER:vvvvvvv PV:vvvvvvv RADIANS:vvvvvvv RATE:vvvvvvv REPLACE:vvvvvvv REPLACEB:vvvvvvv REPT:vvvvvvv " +
	"RIGHT:vvvvvvv RIGHTB:vvvvvvv ROMAN:vvvvvvv ROUND:vvvvvvv ROUNDDOWN:vvvvvvv ROUNDUP:vvvvvvv " +
	"RRI:vvvvvvv SEARCH:vvvvvvv SEARCHB:vvvvvvv SEC:vvvvvvv SECH:vvvvvvv SECOND:vvvvvvv SIGN:vvvvvvv " +
	"SIN:vvvvvvv SINH:vvvvvvv SLN:vvvvvvv SQRT:vvvvvvv STANDARDIZE:vvvvvvv SUBSTITUTE:vvvvvvv SYD:vvvvvvv " +
	"T.DIST:vvvvvvv T.DIST.2T:vvvvvvv T.DIST.RT:vvvvvvv T.INV:vvvvvvv T.INV.2T:vvvvvvv TAN:vvvvvvv " +
	"TANH:vvvvvvv TDIST:vvvvvvv TEXT:vvvvvvv TIME:vvvvvvv TIMEVALUE:vvvvvvv TINV:vvvvvvv TRIM:vvvvvvv " +
	"TRUNC:vvvvvvv UNICHAR:vvvvvvv UNICODE:vvvvvvv UPPER:vvvvvvv VALUE:vvvvvvv VDB:vvvvvvv " +
	"WEBSERVICE:vvvvvvv WEEKDAY:vvvvvvv WEEKNUM:vvvvvvv WEIBULL:vvvvvvv WEIBULL.DIST:vvvvvvv YEAR:vvvvvvv"

// Functions LibreOffice calculates through an add-in or lacks: their arguments as the engine types them (HyperFormula's
// NUMBER, STRING, INTEGER, COMPLEX on an argument not repeated).
const ENGINE =
	"BESSELI:vvxxxxx BESSELJ:vvxxxxx BESSELK:vvxxxxx BESSELY:vvxxxxx BIN2DEC:vxxxxxx BIN2HEX:vvxxxxx " +
	"BIN2OCT:vvxxxxx COMPLEX:vvvxxxx DEC2BIN:vvxxxxx DEC2HEX:vvxxxxx DEC2OCT:vvxxxxx DELTA:vvxxxxx " +
	"DOLLARDE:vvxxxxx DOLLARFR:vvxxxxx EDATE:vvxxxxx EOMONTH:vvxxxxx ERF:vvxxxxx ERFC:vxxxxxx " +
	"FACTDOUBLE:vxxxxxx FVSCHEDULE:vxxxxxx HEX2BIN:vvxxxxx HEX2DEC:vxxxxxx HEX2OCT:vvxxxxx IMABS:vxxxxxx " +
	"IMAGINARY:vxxxxxx IMARGUMENT:vxxxxxx IMCONJUGATE:vxxxxxx IMCOS:vxxxxxx IMCOSH:vxxxxxx IMCOT:vxxxxxx " +
	"IMCSC:vxxxxxx IMCSCH:vxxxxxx IMDIV:vvxxxxx IMEXP:vxxxxxx IMLN:vxxxxxx IMLOG10:vxxxxxx IMLOG2:vxxxxxx " +
	"IMPOWER:vvxxxxx IMREAL:vxxxxxx IMSEC:vxxxxxx IMSECH:vxxxxxx IMSIN:vxxxxxx IMSINH:vxxxxxx " +
	"IMSQRT:vxxxxxx IMSUB:vvxxxxx IMTAN:vxxxxxx MROUND:vvxxxxx OCT2BIN:vvxxxxx OCT2DEC:vxxxxxx " +
	"OCT2HEX:vvxxxxx QUOTIENT:vvxxxxx RANDBETWEEN:vvxxxxx SEQUENCE:vvvvxxx SERIESSUM:vvvxxxx SORT:xxxvxxx " +
	"SQRTPI:vxxxxxx TBILLEQ:vvvxxxx TBILLPRICE:vvvxxxx TBILLYIELD:vvvxxxx WORKDAY:vvxxxxx XIRR:xxvxxxx " +
	"XLOOKUP:xxxxvvx XNPV:vxxxxxx YEARFRAC:vvvxxxx"

// Excel's most arguments, past which nothing is one value.
const MAX_ARGUMENTS = 255
const CLASSED = 7

interface Classes {
	readonly one: string
	readonly min: number
	readonly repeat: number
}

let parsed: Map<string, Classes> | null = null

function classes(): Map<string, Classes> {
	if (parsed !== null) return parsed

	parsed = new Map()

	for (const entry of `${LIBREOFFICE} ${RENAMED} ${DOCUMENTED} ${ENGINE}`.split(" ")) {
		const [name = "", one = "", min = "0", repeat = "0"] = entry.split(":")

		parsed.set(name, { one, min: Number(min), repeat: Number(repeat) })
	}

	return parsed
}

// Whether argument `index` (from 0) of the function `name` (upper case, without its file prefix) takes one value.
export function takesOneValue(name: string, index: number): boolean {
	const known = classes().get(name)

	if (known === undefined || index < 0 || index >= MAX_ARGUMENTS) return false
	if (index < CLASSED) return known.one[index] === "v"
	if (known.repeat === 0) return false

	// Past the seventh: the repeated arguments in turn (GetParameterType).
	const at = known.repeat > 1 ? known.min - ((index - known.min) % known.repeat) : known.min

	return known.one[at] === "v"
}
