import { le16 } from "./bytes"

// [MS-DOC] §2.2.5.1 Sprm: ispmd (9 bits), fSpec (1), sgc (3), spra (3); §2.6 lists every valid sprm.

export const SGC_PARAGRAPH = 1
export const SGC_CHARACTER = 2
export const SGC_SECTION = 4
export const SGC_TABLE = 5

export const SPRM_T_DEF_TABLE = 0xd608
export const SPRM_P_CHG_TABS = 0xc615

export function sprmSgc(sprm: number): number {
	return (sprm >> 10) & 7
}

export function sprmSpra(sprm: number): number {
	return sprm >> 13
}

// Every sprm of [MS-DOC] §2.6.1–§2.6.5, by value.
const TABLE: readonly (readonly [number, string])[] = [
	[0x0800, "sprmCFRMarkDel"],
	[0x0801, "sprmCFRMarkIns"],
	[0x0802, "sprmCFFldVanish"],
	[0x6a03, "sprmCPicLocation"],
	[0x4804, "sprmCIbstRMark"],
	[0x6805, "sprmCDttmRMark"],
	[0x0806, "sprmCFData"],
	[0x4807, "sprmCIdslRMark"],
	[0x6a09, "sprmCSymbol"],
	[0x080a, "sprmCFOle2"],
	[0x2a0c, "sprmCHighlight"],
	[0x0811, "sprmCFWebHidden"],
	[0x6815, "sprmCRsidProp"],
	[0x6816, "sprmCRsidText"],
	[0x6817, "sprmCRsidRMDel"],
	[0x0818, "sprmCFSpecVanish"],
	[0xc81a, "sprmCFMathPr"],
	[0x4a30, "sprmCIstd"],
	[0xca31, "sprmCIstdPermute"],
	[0x2a33, "sprmCPlain"],
	[0x2a34, "sprmCKcd"],
	[0x0835, "sprmCFBold"],
	[0x0836, "sprmCFItalic"],
	[0x0837, "sprmCFStrike"],
	[0x0838, "sprmCFOutline"],
	[0x0839, "sprmCFShadow"],
	[0x083a, "sprmCFSmallCaps"],
	[0x083b, "sprmCFCaps"],
	[0x083c, "sprmCFVanish"],
	[0x2a3e, "sprmCKul"],
	[0x8840, "sprmCDxaSpace"],
	[0x2a42, "sprmCIco"],
	[0x4a43, "sprmCHps"],
	[0x4845, "sprmCHpsPos"],
	[0xca47, "sprmCMajority"],
	[0x2a48, "sprmCIss"],
	[0x484b, "sprmCHpsKern"],
	[0x484e, "sprmCHresi"],
	[0x4a4f, "sprmCRgFtc0"],
	[0x4a50, "sprmCRgFtc1"],
	[0x4a51, "sprmCRgFtc2"],
	[0x4852, "sprmCCharScale"],
	[0x2a53, "sprmCFDStrike"],
	[0x0854, "sprmCFImprint"],
	[0x0855, "sprmCFSpec"],
	[0x0856, "sprmCFObj"],
	[0xca57, "sprmCPropRMark90"],
	[0x0858, "sprmCFEmboss"],
	[0x2859, "sprmCSfxText"],
	[0x085a, "sprmCFBiDi"],
	[0x085c, "sprmCFBoldBi"],
	[0x085d, "sprmCFItalicBi"],
	[0x4a5e, "sprmCFtcBi"],
	[0x485f, "sprmCLidBi"],
	[0x4a60, "sprmCIcoBi"],
	[0x4a61, "sprmCHpsBi"],
	[0xca62, "sprmCDispFldRMark"],
	[0x4863, "sprmCIbstRMarkDel"],
	[0x6864, "sprmCDttmRMarkDel"],
	[0x6865, "sprmCBrc80"],
	[0x4866, "sprmCShd80"],
	[0x4867, "sprmCIdslRMarkDel"],
	[0x0868, "sprmCFUsePgsuSettings"],
	[0x486d, "sprmCRgLid0_80"],
	[0x486e, "sprmCRgLid1_80"],
	[0x286f, "sprmCIdctHint"],
	[0x6870, "sprmCCv"],
	[0xca71, "sprmCShd"],
	[0xca72, "sprmCBrc"],
	[0x4873, "sprmCRgLid0"],
	[0x4874, "sprmCRgLid1"],
	[0x0875, "sprmCFNoProof"],
	[0xca76, "sprmCFitText"],
	[0x6877, "sprmCCvUl"],
	[0xca78, "sprmCFELayout"],
	[0x2879, "sprmCLbcCRJ"],
	[0x0882, "sprmCFComplexScripts"],
	[0x2a83, "sprmCWall"],
	[0xca85, "sprmCCnf"],
	[0x2a86, "sprmCNeedFontFixup"],
	[0x6887, "sprmCPbiIBullet"],
	[0x4888, "sprmCPbiGrf"],
	[0xca89, "sprmCPropRMark"],
	[0x2a90, "sprmCFSdtVanish"],
	[0x4600, "sprmPIstd"],
	[0xc601, "sprmPIstdPermute"],
	[0x2602, "sprmPIncLvl"],
	[0x2403, "sprmPJc80"],
	[0x2405, "sprmPFKeep"],
	[0x2406, "sprmPFKeepFollow"],
	[0x2407, "sprmPFPageBreakBefore"],
	[0x260a, "sprmPIlvl"],
	[0x460b, "sprmPIlfo"],
	[0x240c, "sprmPFNoLineNumb"],
	[0xc60d, "sprmPChgTabsPapx"],
	[0x840e, "sprmPDxaRight80"],
	[0x840f, "sprmPDxaLeft80"],
	[0x4610, "sprmPNest80"],
	[0x8411, "sprmPDxaLeft180"],
	[0x6412, "sprmPDyaLine"],
	[0xa413, "sprmPDyaBefore"],
	[0xa414, "sprmPDyaAfter"],
	[0xc615, "sprmPChgTabs"],
	[0x2416, "sprmPFInTable"],
	[0x2417, "sprmPFTtp"],
	[0x8418, "sprmPDxaAbs"],
	[0x8419, "sprmPDyaAbs"],
	[0x841a, "sprmPDxaWidth"],
	[0x261b, "sprmPPc"],
	[0x2423, "sprmPWr"],
	[0x6424, "sprmPBrcTop80"],
	[0x6425, "sprmPBrcLeft80"],
	[0x6426, "sprmPBrcBottom80"],
	[0x6427, "sprmPBrcRight80"],
	[0x6428, "sprmPBrcBetween80"],
	[0x6629, "sprmPBrcBar80"],
	[0x242a, "sprmPFNoAutoHyph"],
	[0x442b, "sprmPWHeightAbs"],
	[0x442c, "sprmPDcs"],
	[0x442d, "sprmPShd80"],
	[0x842e, "sprmPDyaFromText"],
	[0x842f, "sprmPDxaFromText"],
	[0x2430, "sprmPFLocked"],
	[0x2431, "sprmPFWidowControl"],
	[0x2433, "sprmPFKinsoku"],
	[0x2434, "sprmPFWordWrap"],
	[0x2435, "sprmPFOverflowPunct"],
	[0x2436, "sprmPFTopLinePunct"],
	[0x2437, "sprmPFAutoSpaceDE"],
	[0x2438, "sprmPFAutoSpaceDN"],
	[0x4439, "sprmPWAlignFont"],
	[0x443a, "sprmPFrameTextFlow"],
	[0x2640, "sprmPOutLvl"],
	[0x2441, "sprmPFBiDi"],
	[0x2443, "sprmPFNumRMIns"],
	[0xc645, "sprmPNumRM"],
	[0x6646, "sprmPHugePapx"],
	[0x2447, "sprmPFUsePgsuSettings"],
	[0x2448, "sprmPFAdjustRight"],
	[0x6649, "sprmPItap"],
	[0x664a, "sprmPDtap"],
	[0x244b, "sprmPFInnerTableCell"],
	[0x244c, "sprmPFInnerTtp"],
	[0xc64d, "sprmPShd"],
	[0xc64e, "sprmPBrcTop"],
	[0xc64f, "sprmPBrcLeft"],
	[0xc650, "sprmPBrcBottom"],
	[0xc651, "sprmPBrcRight"],
	[0xc652, "sprmPBrcBetween"],
	[0xc653, "sprmPBrcBar"],
	[0x4455, "sprmPDxcRight"],
	[0x4456, "sprmPDxcLeft"],
	[0x4457, "sprmPDxcLeft1"],
	[0x4458, "sprmPDylBefore"],
	[0x4459, "sprmPDylAfter"],
	[0x245a, "sprmPFOpenTch"],
	[0x245b, "sprmPFDyaBeforeAuto"],
	[0x245c, "sprmPFDyaAfterAuto"],
	[0x845d, "sprmPDxaRight"],
	[0x845e, "sprmPDxaLeft"],
	[0x465f, "sprmPNest"],
	[0x8460, "sprmPDxaLeft1"],
	[0x2461, "sprmPJc"],
	[0x2462, "sprmPFNoAllowOverlap"],
	[0x2664, "sprmPWall"],
	[0x6465, "sprmPIpgp"],
	[0xc666, "sprmPCnf"],
	[0x6467, "sprmPRsid"],
	[0xc669, "sprmPIstdListPermute"],
	[0x646b, "sprmPTableProps"],
	[0xc66c, "sprmPTIstdInfo"],
	[0x246d, "sprmPFContextualSpacing"],
	[0xc66f, "sprmPPropRMark"],
	[0x2470, "sprmPFMirrorIndents"],
	[0x2471, "sprmPTtwo"],
	[0x5400, "sprmTJc90"],
	[0x9601, "sprmTDxaLeft"],
	[0x9602, "sprmTDxaGapHalf"],
	[0x3403, "sprmTFCantSplit90"],
	[0x3404, "sprmTTableHeader"],
	[0xd605, "sprmTTableBorders80"],
	[0x9407, "sprmTDyaRowHeight"],
	[0xd608, "sprmTDefTable"],
	[0xd609, "sprmTDefTableShd80"],
	[0x740a, "sprmTTlp"],
	[0x560b, "sprmTFBiDi"],
	[0xd60c, "sprmTDefTableShd3rd"],
	[0x360d, "sprmTPc"],
	[0x940e, "sprmTDxaAbs"],
	[0x940f, "sprmTDyaAbs"],
	[0x9410, "sprmTDxaFromText"],
	[0x9411, "sprmTDyaFromText"],
	[0xd612, "sprmTDefTableShd"],
	[0xd613, "sprmTTableBorders"],
	[0xf614, "sprmTTableWidth"],
	[0x3615, "sprmTFAutofit"],
	[0xd616, "sprmTDefTableShd2nd"],
	[0xf617, "sprmTWidthBefore"],
	[0xf618, "sprmTWidthAfter"],
	[0x3619, "sprmTFKeepFollow"],
	[0xd61a, "sprmTBrcTopCv"],
	[0xd61b, "sprmTBrcLeftCv"],
	[0xd61c, "sprmTBrcBottomCv"],
	[0xd61d, "sprmTBrcRightCv"],
	[0x941e, "sprmTDxaFromTextRight"],
	[0x941f, "sprmTDyaFromTextBottom"],
	[0xd620, "sprmTSetBrc80"],
	[0x7621, "sprmTInsert"],
	[0x5622, "sprmTDelete"],
	[0x7623, "sprmTDxaCol"],
	[0x5624, "sprmTMerge"],
	[0x5625, "sprmTSplit"],
	[0x7629, "sprmTTextFlow"],
	[0xd62b, "sprmTVertMerge"],
	[0xd62c, "sprmTVertAlign"],
	[0xd62d, "sprmTSetShd"],
	[0xd62e, "sprmTSetShdOdd"],
	[0xd62f, "sprmTSetBrc"],
	[0xd632, "sprmTCellPadding"],
	[0xd633, "sprmTCellSpacingDefault"],
	[0xd634, "sprmTCellPaddingDefault"],
	[0xd635, "sprmTCellWidth"],
	[0xf636, "sprmTFitText"],
	[0xd639, "sprmTFCellNoWrap"],
	[0x563a, "sprmTIstd"],
	[0xd63e, "sprmTCellPaddingStyle"],
	[0xd642, "sprmTCellFHideMark"],
	[0xd660, "sprmTSetShdTable"],
	[0xf661, "sprmTWidthIndent"],
	[0xd662, "sprmTCellBrcType"],
	[0x5664, "sprmTFBiDi90"],
	[0x3465, "sprmTFNoAllowOverlap"],
	[0x3466, "sprmTFCantSplit"],
	[0xd667, "sprmTPropRMark"],
	[0x3668, "sprmTWall"],
	[0x7469, "sprmTIpgp"],
	[0xd66a, "sprmTCnf"],
	[0xd670, "sprmTDefTableShdRaw"],
	[0xd671, "sprmTDefTableShdRaw2nd"],
	[0xd672, "sprmTDefTableShdRaw3rd"],
	[0x7479, "sprmTRsid"],
	[0x347c, "sprmTCellVertAlignStyle"],
	[0x347d, "sprmTCellNoWrapStyle"],
	[0xd47f, "sprmTCellBrcTopStyle"],
	[0xd680, "sprmTCellBrcBottomStyle"],
	[0xd681, "sprmTCellBrcLeftStyle"],
	[0xd682, "sprmTCellBrcRightStyle"],
	[0xd683, "sprmTCellBrcInsideHStyle"],
	[0xd684, "sprmTCellBrcInsideVStyle"],
	[0xd685, "sprmTCellBrcTL2BRStyle"],
	[0xd686, "sprmTCellBrcTR2BLStyle"],
	[0xd687, "sprmTCellShdStyle"],
	[0x3488, "sprmTCHorzBands"],
	[0x3489, "sprmTCVertBands"],
	[0x548a, "sprmTJc"],
	[0x3000, "sprmScnsPgn"],
	[0x3001, "sprmSiHeadingPgn"],
	[0xf203, "sprmSDxaColWidth"],
	[0xf204, "sprmSDxaColSpacing"],
	[0x3005, "sprmSFEvenlySpaced"],
	[0x3006, "sprmSFProtected"],
	[0x5007, "sprmSDmBinFirst"],
	[0x5008, "sprmSDmBinOther"],
	[0x3009, "sprmSBkc"],
	[0x300a, "sprmSFTitlePage"],
	[0x500b, "sprmSCcolumns"],
	[0x900c, "sprmSDxaColumns"],
	[0x300e, "sprmSNfcPgn"],
	[0x3011, "sprmSFPgnRestart"],
	[0x3012, "sprmSFEndnote"],
	[0x3013, "sprmSLnc"],
	[0x5015, "sprmSNLnnMod"],
	[0x9016, "sprmSDxaLnn"],
	[0xb017, "sprmSDyaHdrTop"],
	[0xb018, "sprmSDyaHdrBottom"],
	[0x3019, "sprmSLBetween"],
	[0x301a, "sprmSVjc"],
	[0x501b, "sprmSLnnMin"],
	[0x501c, "sprmSPgnStart97"],
	[0x301d, "sprmSBOrientation"],
	[0xb01f, "sprmSXaPage"],
	[0xb020, "sprmSYaPage"],
	[0xb021, "sprmSDxaLeft"],
	[0xb022, "sprmSDxaRight"],
	[0x9023, "sprmSDyaTop"],
	[0x9024, "sprmSDyaBottom"],
	[0xb025, "sprmSDzaGutter"],
	[0x5026, "sprmSDmPaperReq"],
	[0x3228, "sprmSFBiDi"],
	[0x322a, "sprmSFRTLGutter"],
	[0x702b, "sprmSBrcTop80"],
	[0x702c, "sprmSBrcLeft80"],
	[0x702d, "sprmSBrcBottom80"],
	[0x702e, "sprmSBrcRight80"],
	[0x522f, "sprmSPgbProp"],
	[0x7030, "sprmSDxtCharSpace"],
	[0x9031, "sprmSDyaLinePitch"],
	[0x5032, "sprmSClm"],
	[0x5033, "sprmSTextFlow"],
	[0xd234, "sprmSBrcTop"],
	[0xd235, "sprmSBrcLeft"],
	[0xd236, "sprmSBrcBottom"],
	[0xd237, "sprmSBrcRight"],
	[0x3239, "sprmSWall"],
	[0x703a, "sprmSRsid"],
	[0x303b, "sprmSFpc"],
	[0x303c, "sprmSRncFtn"],
	[0x303e, "sprmSRncEdn"],
	[0x503f, "sprmSNFtn"],
	[0x5040, "sprmSNfcFtnRef"],
	[0x5041, "sprmSNEdn"],
	[0x5042, "sprmSNfcEdnRef"],
	[0xd243, "sprmSPropRMark"],
	[0x7044, "sprmSPgnStart"],
	[0x6c02, "sprmPicBrcTop80"],
	[0x6c03, "sprmPicBrcLeft80"],
	[0x6c04, "sprmPicBrcBottom80"],
	[0x6c05, "sprmPicBrcRight80"],
	[0xce08, "sprmPicBrcTop"],
	[0xce09, "sprmPicBrcLeft"],
	[0xce0a, "sprmPicBrcBottom"],
	[0xce0b, "sprmPicBrcRight"]
]

export const SPRM_NAMES: ReadonlyMap<number, string> = new Map(TABLE)

export function sprmName(sprm: number): string {
	return SPRM_NAMES.get(sprm) ?? `sprm0x${sprm.toString(16).padStart(4, "0")}`
}

// The operand's size in bytes, from spra (§2.2.5.1), or -1 when it runs past `end`.
export function operandLength(data: Uint8Array, at: number, end: number, sprm: number): number {
	let length: number

	switch (sprmSpra(sprm)) {
		case 0:
		case 1:
			length = 1
			break
		case 2:
		case 4:
		case 5:
			length = 2
			break
		case 3:
			length = 4
			break
		case 7:
			length = 3
			break
		default:
			if (at >= end) return -1

			if (sprm === SPRM_T_DEF_TABLE) {
				// TDefTableOperand.cb counts the rest of the operand plus one (§2.9.321).
				if (at + 2 > end) return -1

				length = 2 + Math.max(0, le16(data, at) - 1)
			} else if (sprm === SPRM_P_CHG_TABS) {
				// PChgTabsOperand.cb (§2.9.182); 255 means the size follows from the two counts.
				const cb = data[at] ?? 0

				if (cb !== 255) {
					length = 1 + cb
				} else {
					const deleted = data[at + 1] ?? 0
					const addAt = at + 2 + 4 * deleted

					if (addAt >= end) return -1

					length = 2 + 4 * deleted + 1 + 3 * (data[addAt] ?? 0)
				}
			} else {
				length = 1 + (data[at] ?? 0)
			}
	}

	return at + length <= end ? length : -1
}

// Calls `visit` for each Prl in data[start, end): the sprm and its operand's offset and size. A Prl that runs past
// `end` ends the walk (a truncated grpprl keeps what precedes it). The operand of a variable-length sprm starts at
// its size byte(s).
export function forEachPrl(
	data: Uint8Array,
	start: number,
	end: number,
	visit: (sprm: number, operand: number, length: number) => void
): void {
	let at = start
	const limit = Math.min(end, data.length)

	while (at + 2 <= limit) {
		const sprm = le16(data, at)
		const length = operandLength(data, at + 2, limit, sprm)

		if (length < 0) return

		visit(sprm, at + 2, length)
		at += 2 + length
	}
}

// One property modifier; the operand is a view of the file's bytes.
export interface Prl {
	readonly sprm: number
	readonly operand: Uint8Array
}

export function readPrls(data: Uint8Array, start: number, end: number): Prl[] {
	const out: Prl[] = []

	forEachPrl(data, start, end, (sprm, operand, length) => {
		out.push({ sprm, operand: data.subarray(operand, operand + length) })
	})

	return out
}
