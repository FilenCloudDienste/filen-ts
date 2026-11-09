import type { Bytes } from "./bytes"
import { DocError } from "./errors"

// [MS-DOC] §2.5.1 Fib: FibBase, FibRgW97, FibRgLw97, FibRgFcLcbBlob, FibRgCswNew.

export const WORD_IDENT = 0xa5ec
// The first nFib with the Word 97 Fib layout; earlier (Word 6 = 0x65, Word 95 = 0x68) lay the Fib out differently.
export const NFIB_WORD97 = 0x00c1

// Indexes of the fc/lcb pairs in FibRgFcLcb97 (§2.5.6), in file order.
export const FC = {
	stshfOrig: 0,
	stshf: 1,
	plcffndRef: 2,
	plcffndTxt: 3,
	plcfandRef: 4,
	plcfandTxt: 5,
	plcfSed: 6,
	plcPad: 7,
	plcfPhe: 8,
	sttbfGlsy: 9,
	plcfGlsy: 10,
	plcfHdd: 11,
	plcfBteChpx: 12,
	plcfBtePapx: 13,
	plcfSea: 14,
	sttbfFfn: 15,
	plcfFldMom: 16,
	plcfFldHdr: 17,
	plcfFldFtn: 18,
	plcfFldAtn: 19,
	plcfFldMcr: 20,
	sttbfBkmk: 21,
	plcfBkf: 22,
	plcfBkl: 23,
	cmds: 24,
	sttbfMcr: 26,
	prDrvr: 27,
	prEnvPort: 28,
	prEnvLand: 29,
	wss: 30,
	dop: 31,
	sttbfAssoc: 32,
	clx: 33,
	plcfPgdFtn: 34,
	autosaveSource: 35,
	grpXstAtnOwners: 36,
	sttbfAtnBkmk: 37,
	plcSpaMom: 40,
	plcSpaHdr: 41,
	plcfAtnBkf: 42,
	plcfAtnBkl: 43,
	pms: 44,
	formFldSttbs: 45,
	plcfendRef: 46,
	plcfendTxt: 47,
	plcfFldEdn: 48,
	dggInfo: 50,
	sttbfRMark: 51,
	sttbfCaption: 52,
	sttbfAutoCaption: 53,
	plcfWkb: 54,
	plcfSpl: 55,
	plcftxbxTxt: 56,
	plcfFldTxbx: 57,
	plcfHdrtxbxTxt: 58,
	plcffldHdrTxbx: 59,
	stwUser: 60,
	sttbTtmbd: 61,
	cookieData: 62,
	sttbfIntlFld: 69,
	routeSlip: 70,
	sttbSavedBy: 71,
	sttbFnm: 72,
	plfLst: 73,
	plfLfo: 74,
	plcfTxbxBkd: 75,
	plcfTxbxHdrBkd: 76,
	docUndoWord9: 77,
	rgbUse: 78,
	usp: 79,
	uskf: 80,
	plcupcRgbUse: 81,
	plcupcUsp: 82,
	sttbGlsyStyle: 83,
	plgosl: 84,
	plcocx: 85,
	plcfBteLvc: 86,
	plcfLvcPre10: 88,
	plcfAsumy: 89,
	plcfGram: 90,
	sttbListNames: 91,
	sttbfUssr: 92,
	// FibRgFcLcb2002: after the 15 pairs FibRgFcLcb2000 adds, then fcUnused1, fcPlcfPgp, fcPlcfuim, fcPlfguidUim.
	atrdExtra: 112
} as const

export type FcName = keyof typeof FC

// FibRgLw97 (§2.5.4) members this reader uses.
export interface DocCcp {
	readonly text: number
	readonly ftn: number
	readonly hdd: number
	readonly atn: number
	readonly edn: number
	readonly txbx: number
	readonly hdrTxbx: number
}

export interface DocFib {
	// FibRgCswNew.nFibNew when present, else FibBase.nFib (§2.5.1, "nFib").
	readonly nFib: number
	readonly lid: number
	// FibRgW97.lidFE
	readonly lidFE: number
	readonly fDot: boolean
	readonly fGlsy: boolean
	// FibBase.pnNext: in a template, the 512-byte page of the WordDocument stream where the Fib of its AutoText
	// document starts; 0 for none (§2.5.2).
	readonly pnNext: number
	readonly fComplex: boolean
	readonly fHasPic: boolean
	readonly cQuickSaves: number
	readonly fEncrypted: boolean
	readonly fObfuscated: boolean
	// 1Table when set, else 0Table.
	readonly fWhichTblStm: boolean
	readonly fReadOnlyRecommended: boolean
	readonly fWriteReservation: boolean
	readonly fFarEast: boolean
	readonly lKey: number
	readonly cbMac: number
	readonly ccp: DocCcp
	// The fc and lcb of one FibRgFcLcb pair; [0, 0] past the pairs the file has.
	fcLcb(name: FcName): readonly [fc: number, lcb: number]
}

const FIB_BASE = 32

export function readFib(word: Bytes): DocFib {
	if (word.length < FIB_BASE + 2) throw new DocError("corrupt", "WordDocument stream is shorter than FibBase")

	const ident = word.u16(0)
	const baseNFib = word.u16(2)

	// Word 6 and earlier write wIdent 0xA5DC.
	if (ident !== WORD_IDENT && !(ident === 0xa5dc && baseNFib < NFIB_WORD97)) {
		throw new DocError("badSignature", `FibBase.wIdent is 0x${ident.toString(16)}`)
	}

	const lid = word.u16(6)
	const pnNext = word.u16(8)
	const flags = word.u16(10)
	const lKey = word.u32(14)
	const fEncrypted = (flags & 0x0100) !== 0

	// Word 6/95 files carry their nFib in FibBase too, and their Fib differs from here on.
	if (baseNFib < NFIB_WORD97) {
		throw new DocError("legacyVersion", `nFib 0x${baseNFib.toString(16)} predates the Word 97 file format`, { nFib: baseNFib })
	}

	const base = {
		lid,
		fDot: (flags & 0x0001) !== 0,
		fGlsy: (flags & 0x0002) !== 0,
		pnNext,
		fComplex: (flags & 0x0004) !== 0,
		fHasPic: (flags & 0x0008) !== 0,
		cQuickSaves: (flags >> 4) & 0xf,
		fEncrypted,
		fWhichTblStm: (flags & 0x0200) !== 0,
		fReadOnlyRecommended: (flags & 0x0400) !== 0,
		fWriteReservation: (flags & 0x0800) !== 0,
		fFarEast: (flags & 0x4000) !== 0,
		fObfuscated: (flags & 0x8000) !== 0,
		lKey
	}

	// Past FibBase an encrypted file is ciphertext (the first 68 bytes stay clear for RC4; see [MS-DOC] §2.2.6.2),
	// so the caller refuses before reading further.
	if (fEncrypted) {
		return { ...base, nFib: baseNFib, lidFE: 0, cbMac: 0, ccp: EMPTY_CCP, fcLcb: () => [0, 0] }
	}

	let at = FIB_BASE
	const csw = word.u16(at)

	at += 2
	word.check(at, csw * 2, "FibRgW97")

	const lidFE = csw >= 14 ? word.u16(at + 26) : 0

	at += csw * 2

	const cslw = word.u16(at)

	at += 2
	word.check(at, cslw * 4, "FibRgLw97")

	const lw = (k: number): number => (k < cslw ? word.i32(at + 4 * k) : 0)
	const cbMac = lw(0)
	const ccp: DocCcp = {
		text: Math.max(0, lw(3)),
		ftn: Math.max(0, lw(4)),
		hdd: Math.max(0, lw(5)),
		atn: Math.max(0, lw(7)),
		edn: Math.max(0, lw(8)),
		txbx: Math.max(0, lw(9)),
		hdrTxbx: Math.max(0, lw(10))
	}

	at += cslw * 4

	const cbRgFcLcb = word.u16(at)

	at += 2
	word.check(at, cbRgFcLcb * 8, "FibRgFcLcbBlob")

	const pairsAt = at

	at += cbRgFcLcb * 8

	let nFib = baseNFib

	if (word.has(at, 2)) {
		const cswNew = word.u16(at)

		if (cswNew > 0 && word.has(at + 2, 2)) nFib = word.u16(at + 2)
	}

	return {
		...base,
		nFib,
		lidFE,
		cbMac,
		ccp,
		fcLcb(name: FcName): readonly [number, number] {
			const index = FC[name]

			if (index >= cbRgFcLcb) return [0, 0]

			return [word.u32(pairsAt + 8 * index), word.u32(pairsAt + 8 * index + 4)]
		}
	}
}

const EMPTY_CCP: DocCcp = { text: 0, ftn: 0, hdd: 0, atn: 0, edn: 0, txbx: 0, hdrTxbx: 0 }
