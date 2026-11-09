# Third-party notices

`@filen/office` is licensed under the GNU Affero General Public License v3.0. It contains code derived from the projects below; each derived file carries a header naming its source.

## SuperDoc 1.x

- Source: SuperDoc v1.46.3 (`e096323e7d5e54f95b4817d1d3aefde8c37d52cf`), https://github.com/superdoc/docx-editor
- Copyright: Harbour and the SuperDoc contributors
- Licence: GNU Affero General Public License v3.0
- Derived files, modified for `@filen/office` (AGPL-3.0 §5a), first ported and last changed on 2026-10-11:
  - `src/core/docx/numbering/formats.ts` (from `shared/common/list-numbering`)
  - `src/core/docx/numbering/counter.ts` (from `packages/word-layout/src/numbering-manager.ts`)
  - `src/core/docx/styles/merge.ts` (from `packages/layout-engine/style-engine/src/cascade.ts`)
  - `src/core/docx/styles/resolve.ts` and `src/core/docx/styles/tableStyle.ts` (from `packages/layout-engine/style-engine/src/ooxml/index.ts`)
  - `src/core/math/omml.ts` (from `packages/layout-engine/painters/dom/src/features/math`)
  - `src/core/math/tokens.ts` (from `packages/layout-engine/painters/dom/src/features/math/converters/math-run.ts`)

Only the AGPL-3.0 1.x line is used. No code from `superdoc` 2.3 or later, or from `@superdoc/docx-engine`, is included.

## docx-preview (docxjs)

- Source: docx-preview 0.4.1 (docxjs `c533f383`), https://github.com/VolodymyrBaydalka/docxjs
- Copyright: Volodymyr Baydalka
- Licence: Apache License 2.0 (text below)
- Derived files, modified for `@filen/office`, first ported and last changed on 2026-10-11:
  - `src/core/math/omml.ts` (from `src/html-renderer.ts`, the `renderMml*` functions)

## ECMA-376 preset shape definitions

- Source: ECMA-376 Part 1, 5th edition (December 2016), annex `OfficeOpenXML-DrawingMLGeometries.zip`, `presetShapeDefinitions.xml` (SHA-256 `2f7c868d857c1e3c4b5a6068759fe0e07d77ad58377a6618d1b02ba3507b6939`), https://ecma-international.org/publications-and-standards/standards/ecma-376/
- Copyright: Ecma International
- `src/core/drawingml/geometry/presets.generated.ts` is generated from it by `src/scripts/presetGeometry.ts` (re-encoded, not copied), implementing the specification's functionality in a conformant product (permission (iv) below).
- Also from the same annex: `presetTextWarpDefinitions.xml` (SHA-256 `89640bd4aeedfa2c578d1d1acc50d569865ebdef315fd4b468087c25e36acada`). `src/core/presentation/render/warps.generated.ts` is generated from it by `src/scripts/presetTextWarp.ts` (re-encoded, not copied), under the same permission.
- Also: ECMA-376 Part 4, 5th edition (December 2016), `OfficeOpenXML-XMLSchema-Transitional.zip`, `wml.xsd` (SHA-256 `0f7784b36ddc42950e5ff354cd608b83b60e4de39325d5568913f1225365029b`) and `sml.xsd` (SHA-256 `495debc8fa967b77ed37799747b049832f2c95b2ecdb9f19ddcd68f8c9f96ab9`). `src/core/docx/write/order.generated.ts` and `src/core/xlsx/write/order.generated.ts` list child element orders and enumerated values read from them by `src/scripts/wmlOrder.ts` and `src/scripts/smlOrder.ts`, under the same permission. The schema validation tests (`src/tests/docxWriteSchema.test.ts`, `src/tests/oracles/sheet/sheetSchema.test.ts`) read the whole schema set from the pinned archive at test time; none of it is committed.
- Licence: the Ecma default copyright notice ("Ecma text copyright policy", version 3, https://ecma-international.org/wp-content/uploads/Ecma_text_copyright_policy_version_3.pdf, SHA-256 `2dcbec958059c8b512b6798ee1f0b8416c33d507a21f5bd9a20c19e68218776f`), reproduced verbatim (line breaks of the PDF joined into paragraphs):

```
COPYRIGHT NOTICE
© Ecma International
By obtaining and/or copying this work, you (the licensee) agree that you have read, understood, and will comply with the following terms and conditions.
This document may be copied, published and distributed to others, and certain derivative works of it may be prepared, copied, published, and distributed, in whole or in part, provided that the above copyright notice and this Copyright License and Disclaimer are included on all such copies and derivative works. The only derivative works that are permissible under this Copyright License and Disclaimer are:
(i) works which incorporate all or portion of this document for the purpose of providing commentary or explanation (such as an annotated version of the document),
(ii) works which incorporate all or portion of this document for the purpose of incorporating features that provide accessibility,
(iii) translations of this document into languages other than English and into different formats and
(iv) works by making use of this specification in standard conformant products by implementing (e.g. by copy and paste wholly or partly) the functionality therein.
However, the content of this document itself may not be modified in any way, including by removing the copyright notice or references to Ecma International, except as required to translate it into languages other than English or into a different format.
The official version of an Ecma International document is the English language version on the Ecma International website. In the event of discrepancies between a translated version and the official version, the official version shall govern.
The limited permissions granted above are perpetual and will not be revoked by Ecma International or its successors or assigns.
This document and the information contained herein is provided on an “AS IS” basis and ECMA INTERNATIONAL DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTY THAT THE USE OF THE INFORMATION HEREIN WILL NOT INFRINGE ANY OWNERSHIP RIGHTS OR ANY IMPLIED WARRANTIES OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
```

## [MS-DOC] Word (.doc) Binary File Format

- Source: [MS-DOC] v20260217 (release February 17, 2026), PDF (SHA-256 `23fd1a8413ff8fa2902097060ae7dea031fca9a7979ca20633c141a756ddb27c`), https://officeprotocoldoc.z19.web.core.windows.net/files/MS-DOC/%5BMS-DOC%5D.pdf
- Copyright: © 2026 Microsoft Corporation
- `src/core/doc/sprms.ts` holds the name and value of every sprm of §2.6.1–§2.6.5 (re-encoded as a table, not copied), implementing the format under the notice's permission to make copies in order to develop implementations. The rest of `src/core/doc/` implements the format from the specification; none of its text is copied.
- Licence: the "Intellectual Property Rights Notice for Open Specifications Documentation" on the document's first page, reproduced verbatim (line breaks of the PDF joined into paragraphs):

```
Intellectual Property Rights Notice for Open Specifications Documentation
Technical Documentation. Microsoft publishes Open Specifications documentation (“this documentation”) for protocols, file formats, data portability, computer languages, and standards support. Additionally, overview documents cover inter-protocol relationships and interactions.
Copyrights. This documentation is covered by Microsoft copyrights. Regardless of any other terms that are contained in the terms of use for the Microsoft website that hosts this documentation, you can make copies of it in order to develop implementations of the technologies that are described in this documentation and can distribute portions of it in your implementations that use these technologies or in your documentation as necessary to properly document the implementation. You can also distribute in your implementation, with or without modification, any schemas, IDLs, or code samples that are included in the documentation. This permission also applies to any documents that are referenced in the Open Specifications documentation.
No Trade Secrets. Microsoft does not claim any trade secret rights in this documentation.
Patents. Microsoft has patents that might cover your implementations of the technologies described in the Open Specifications documentation. Neither this notice nor Microsoft's delivery of this documentation grants any licenses under those patents or any other Microsoft patents. However, a given Open Specifications document might be covered by the Microsoft Open Specifications Promise or the Microsoft Community Promise. If you would prefer a written license, or if the technologies described in this documentation are not covered by the Open Specifications Promise or Community Promise, as applicable, patent licenses are available by contacting iplg@microsoft.com.
License Programs. To see all of the protocols in scope under a specific license program and the associated patents, visit the Patent Map.
Trademarks. The names of companies and products contained in this documentation might be covered by trademarks or similar intellectual property rights. This notice does not grant any licenses under those rights. For a list of Microsoft trademarks, visit www.microsoft.com/trademarks.
Fictitious Names. The example companies, organizations, products, domain names, email addresses, logos, people, places, and events that are depicted in this documentation are fictitious. No association with any real company, organization, product, domain name, email address, logo, person, place, or event is intended or should be inferred.
Reservation of Rights. All other rights are reserved, and this notice does not grant any rights other than as specifically described above, whether by implication, estoppel, or otherwise.
Tools. The Open Specifications documentation does not require the use of Microsoft programming tools or programming environments in order for you to develop an implementation. If you have access to Microsoft programming tools and environments, you are free to take advantage of them. Certain Open Specifications documents are intended for use in conjunction with publicly available standards specifications and network programming art and, as such, assume that the reader either is familiar with the aforementioned material or has immediate access to it.
Support. For questions and support, please contact dochelp@microsoft.com.
```

## [MS-ODRAW] Office Drawing Binary File Format

- Source: [MS-ODRAW] v20250819 (release August 19, 2025), PDF (SHA-256 `fbc67309646b0b95e87f66eb7a3d89c6f08153c46379f496b886a8deae42d7e5`), https://officeprotocoldoc.z19.web.core.windows.net/files/MS-ODRAW/%5bMS-ODRAW%5d.pdf
- Copyright: © 2025 Microsoft Corporation
- `src/core/doc/toDocx/officeArt.ts` and `src/core/ppt/officeArt.ts` hold the record types of §2.2 and the property ids of §2.3 they read (re-encoded as constants, not copied), under the same permission. `src/core/doc/toDocx/convert.ts` implements the shape properties it converts from the specification; none of its text is copied.
- Licence: the "Intellectual Property Rights Notice for Open Specifications Documentation" on the document's first page, reproduced verbatim (line breaks of the PDF joined into paragraphs):

```
Intellectual Property Rights Notice for Open Specifications Documentation
Technical Documentation. Microsoft publishes Open Specifications documentation (“this documentation”) for protocols, file formats, data portability, computer languages, and standards support. Additionally, overview documents cover inter-protocol relationships and interactions.
Copyrights. This documentation is covered by Microsoft copyrights. Regardless of any other terms that are contained in the terms of use for the Microsoft website that hosts this documentation, you can make copies of it in order to develop implementations of the technologies that are described in this documentation and can distribute portions of it in your implementations that use these technologies or in your documentation as necessary to properly document the implementation. You can also distribute in your implementation, with or without modification, any schemas, IDLs, or code samples that are included in the documentation. This permission also applies to any documents that are referenced in the Open Specifications documentation.
No Trade Secrets. Microsoft does not claim any trade secret rights in this documentation.
Patents. Microsoft has patents that might cover your implementations of the technologies described in the Open Specifications documentation. Neither this notice nor Microsoft's delivery of this documentation grants any licenses under those patents or any other Microsoft patents. However, a given Open Specifications document might be covered by the Microsoft Open Specifications Promise or the Microsoft Community Promise. If you would prefer a written license, or if the technologies described in this documentation are not covered by the Open Specifications Promise or Community Promise, as applicable, patent licenses are available by contacting iplg@microsoft.com.
License Programs. To see all of the protocols in scope under a specific license program and the associated patents, visit the Patent Map.
Trademarks. The names of companies and products contained in this documentation might be covered by trademarks or similar intellectual property rights. This notice does not grant any licenses under those rights. For a list of Microsoft trademarks, visit www.microsoft.com/trademarks.
Fictitious Names. The example companies, organizations, products, domain names, email addresses, logos, people, places, and events that are depicted in this documentation are fictitious. No association with any real company, organization, product, domain name, email address, logo, person, place, or event is intended or should be inferred.
Reservation of Rights. All other rights are reserved, and this notice does not grant any rights other than as specifically described above, whether by implication, estoppel, or otherwise.
Tools. The Open Specifications documentation does not require the use of Microsoft programming tools or programming environments in order for you to develop an implementation. If you have access to Microsoft programming tools and environments, you are free to take advantage of them. Certain Open Specifications documents are intended for use in conjunction with publicly available standards specifications and network programming art and, as such, assume that the reader either is familiar with the aforementioned material or has immediate access to it.
Support. For questions and support, please contact dochelp@microsoft.com.
```


## [MS-PPT] PowerPoint (.ppt) Binary File Format

- Source: [MS-PPT] v20241112 (release November 12, 2024), PDF (SHA-256 `4cdd467ceb57bb91aa40c2733b8d6f3408b41b4ed3b652270a73901487a9adf1`), https://officeprotocoldoc.z19.web.core.windows.net/files/MS-PPT/%5BMS-PPT%5D.pdf
- Copyright: © 2024 Microsoft Corporation
- `src/core/ppt/records.ts` holds the record types of §2.13.24 the reader uses, and `src/core/ppt/anim.ts` and `src/core/ppt/text.ts` the values of the time node and text property fields they read (re-encoded as constants, not copied), under the notice's permission to make copies in order to develop implementations. The rest of `src/core/ppt/` implements the format from the specification; none of its text is copied.
- Licence: the "Intellectual Property Rights Notice for Open Specifications Documentation" on the document's first page, reproduced verbatim (line breaks of the PDF joined into paragraphs):

```
Intellectual Property Rights Notice for Open Specifications Documentation
Technical Documentation. Microsoft publishes Open Specifications documentation (“this documentation”) for protocols, file formats, data portability, computer languages, and standards support. Additionally, overview documents cover inter-protocol relationships and interactions.
Copyrights. This documentation is covered by Microsoft copyrights. Regardless of any other terms that are contained in the terms of use for the Microsoft website that hosts this documentation, you can make copies of it in order to develop implementations of the technologies that are described in this documentation and can distribute portions of it in your implementations that use these technologies or in your documentation as necessary to properly document the implementation. You can also distribute in your implementation, with or without modification, any schemas, IDLs, or code samples that are included in the documentation. This permission also applies to any documents that are referenced in the Open Specifications documentation.
No Trade Secrets. Microsoft does not claim any trade secret rights in this documentation.
Patents. Microsoft has patents that might cover your implementations of the technologies described in the Open Specifications documentation. Neither this notice nor Microsoft's delivery of this documentation grants any licenses under those patents or any other Microsoft patents. However, a given Open Specifications document might be covered by the Microsoft Open Specifications Promise or the Microsoft Community Promise. If you would prefer a written license, or if the technologies described in this documentation are not covered by the Open Specifications Promise or Community Promise, as applicable, patent licenses are available by contacting iplg@microsoft.com.
License Programs. To see all of the protocols in scope under a specific license program and the associated patents, visit the Patent Map.
Trademarks. The names of companies and products contained in this documentation might be covered by trademarks or similar intellectual property rights. This notice does not grant any licenses under those rights. For a list of Microsoft trademarks, visit www.microsoft.com/trademarks.
Fictitious Names. The example companies, organizations, products, domain names, email addresses, logos, people, places, and events that are depicted in this documentation are fictitious. No association with any real company, organization, product, domain name, email address, logo, person, place, or event is intended or should be inferred.
Reservation of Rights. All other rights are reserved, and this notice does not grant any rights other than as specifically described above, whether by implication, estoppel, or otherwise.
Tools. The Open Specifications documentation does not require the use of Microsoft programming tools or programming environments in order for you to develop an implementation. If you have access to Microsoft programming tools and environments, you are free to take advantage of them. Certain Open Specifications documents are intended for use in conjunction with publicly available standards specifications and network programming art and, as such, assume that the reader either is familiar with the aforementioned material or has immediate access to it.
Support. For questions and support, please contact dochelp@microsoft.com.
```
## Unicode symbol-font mappings

- Source: Unicode, Inc. symbol mappings of 2012-11-06 (ISO/IEC JTC1/SC2/WG2 N4384) and 2011-07-12 (Adobe Symbol Encoding to Unicode 1.0), https://www.unicode.org/
- Copyright: Unicode, Inc.

`src/core/fonts/symbols.generated.ts` is generated by `src/scripts/symbolTables.ts` from two Unicode, Inc. publications (re-encoded as code tables, not copied):

- Wingdings, Wingdings 2, Wingdings 3 and Webdings: ISO/IEC JTC1/SC2/WG2 N4384 (Unicode L2/12-368, "Status of encoding of Wingdings and Webdings Symbols", 2012-11-06), https://www.unicode.org/L2/L2012/12368-n4384.pdf (SHA-256 `15839e133b3ab10b84d68f41f25138d9dedbc94a8a6c2dbb155439d597084a0b`), used under the Unicode Terms of Use, https://www.unicode.org/copyright.html
- Symbol: "Adobe Symbol Encoding to Unicode", table version 1.0 (2011 July 12), https://www.unicode.org/Public/MAPPINGS/VENDORS/ADOBE/symbol.txt (SHA-256 `deb78ca840a429311939b9d165890873f71fb23ef223ceeb144a6c6d641a7e52`), whose notice is reproduced verbatim as it requires:

```
Copyright (c) 1991-2011 Unicode, Inc. All Rights reserved.

This file is provided as-is by Unicode, Inc. (The Unicode Consortium). No
claims are made as to fitness for any particular purpose. No warranties of
any kind are expressed or implied. The recipient agrees to determine
applicability of information provided. If this file has been provided on
magnetic media by Unicode, Inc., the sole remedy for any claim will be
exchange of defective media within 90 days of receipt.

Unicode, Inc. hereby grants the right to freely use the information
supplied in this file in the creation of products supporting the
Unicode Standard, and to make copies of this file in any form for
internal or external distribution as long as this notice remains
attached.
```

## Metafile symbol-font supplements

- Source: Apple's Mac OS Symbol to Unicode mapping version c02 (2005-04-05), Adobe's Symbol font metrics and the Mozilla MathML project's MT Extra encoding page, https://www.unicode.org/Public/MAPPINGS/VENDORS/APPLE/SYMBOL.TXT
- Copyright: (c) 1994-2002, 2005 Apple Computer, Inc.; © 1998–2009 individual mozilla.org contributors

`src/core/metafile/text.ts` and `src/core/metafile/mtextra.ts` map further symbol-font tables for metafile text, re-encoded as code tables (no file is copied):

- The Symbol font's bracket, brace and integral pieces and arrow extensions: 22 factual code-to-character mappings (0xBD → U+23D0, 0xBE → U+23AF, 0xE6–0xEF → U+239B–U+239D, U+23A1–U+23A3, U+23A7–U+23AA, 0xF4 → U+23AE, 0xF6–0xFE → U+239E–U+23A0, U+23A4–U+23A6, U+23AB–U+23AD) taken from Apple's "Map (external version) from Mac OS Symbol character set to Unicode 4.0 and later", version c02 (2005-04-05), https://www.unicode.org/Public/MAPPINGS/VENDORS/APPLE/SYMBOL.TXT (SHA-256 `b8c529daba09a45872ec3b493e944680528206b829193594dcdd774a02d49d12`). Its copyright line and disclaimer, reproduced verbatim:

```
Copyright:  (c) 1994-2002, 2005 by Apple Computer, Inc., all rights
            reserved.

Apple Computer, Inc. ("Apple") makes no warranty or representation,
either express or implied, with respect to this document and the
included data, its quality, accuracy, or fitness for a particular
purpose. In no event will Apple be liable for direct, indirect,
special, incidental, or consequential damages resulting from any
defect or inaccuracy in this document or the included data.
```

- The advance widths of those pieces in Symbol (five facts: 384, 494, 686, 603 and 1000 units per em), from Adobe's Symbol font metrics, `Symbol.afm` version 001.008 of the Core 14 AFM set ("Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe Systems Incorporated. All rights reserved."), used to centre a piece in its Symbol cell.
- MT Extra (MathType's companion font), codes 0x20–0x7F, in `src/core/metafile/mtextra.ts`:
  - Source: the Mozilla MathML project's "MT Extra" encoding page, https://www-archive.mozilla.org/projects/mathml/fonts/encoding/mtextra (SHA-256 `b36a96233316626a49c26e9e30d42ae422283798c3b87664510474c7da03e06a`). No MT Extra font file was read.
  - Attribution: "Portions of this content are © 1998–2009 by individual mozilla.org contributors".
  - Licence to us: Creative Commons Attribution-ShareAlike 4.0 International (https://creativecommons.org/licenses/by-sa/4.0/). The page's licence (https://www.mozilla.org/foundation/licensing/website-content/) is CC BY-SA 3.0 Unported "or any later version".
  - Disclaimer: the material is offered as-is, without warranties of any kind (section 5 of the licence).
  - Modified: the combining embellishments are mapped to their spacing forms, the arrow embellishments to spacing arrows, and the stretchy brace pieces are left out.
  - Our adaptation is licensed under the GNU General Public License version 3 (GPL-3.0-only), under Creative Commons' declared one-way compatibility of BY-SA 4.0 with GPLv3 (https://wiki.creativecommons.org/wiki/ShareAlike_compatibility:_GPLv3), and is combined with the rest of `@filen/office` under section 13 of the GNU Affero General Public License v3.0.

## pdf.js

- Source: pdfjs-dist 6.3.289, https://github.com/mozilla/pdf.js
- Copyright: 2014 Mozilla Foundation
- Licence: Apache License 2.0 (text below)
- Derived files, modified for `@filen/office`:
  - `src/css/pdf.css` (the `.textLayer` rules of `web/pdf_viewer.css`, selector renamed and colours made variables)

## HarfBuzz

- Source: HarfBuzz 14.6.0 (`COPYING` SHA-256 `ba8f810f2455c2f08e2d56bb49b72f37fcf68f1f4fade38977cfd7372050ad64`), https://github.com/harfbuzz/harfbuzz
- Copyright: the HarfBuzz authors (Google, Inc., Behdad Esfahbod, Red Hat, Inc. and the others its `COPYING` lists)
- Licence: "Old MIT" (text below)
- Derived files, written for `@filen/office` (tables and the structure of the algorithms ported to TypeScript, no source file copied), first ported and last changed on 2026-10-22:
  - `src/core/pdfwrite/fonts/shape.ts` (the Arabic joining state table of `src/hb-ot-shaper-arabic.cc`; the default feature order of `src/hb-ot-shape.cc`)
  - `src/core/pdfwrite/fonts/indic.ts` (the syllable grammar of `src/hb-ot-shaper-indic-machine.rl`; initial and final reordering and the per-script settings of `src/hb-ot-shaper-indic.cc`)
  - `src/core/pdfwrite/fonts/unicode.ts` (the modified combining classes of `src/hb-unicode.hh`)
  - `src/core/pdfwrite/fonts/gpos.ts` (the cursive attachment convention of `src/OT/Layout/GPOS/CursivePosFormat1.hh`)
- `src/tests/fixtures/pdfFonts/harfbuzz.json` is the output of `hb-shape` 14.6.0 for the test samples.

```
Permission is hereby granted, without written agreement and without
license or royalty fees, to use, copy, modify, and distribute this
software and its documentation for any purpose, provided that the
above copyright notice and the following two paragraphs appear in
all copies of this software.

IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE TO ANY PARTY FOR
DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES
ARISING OUT OF THE USE OF THIS SOFTWARE AND ITS DOCUMENTATION, EVEN
IF THE COPYRIGHT HOLDER HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.

THE COPYRIGHT HOLDER SPECIFICALLY DISCLAIMS ANY WARRANTIES, INCLUDING,
BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE.  THE SOFTWARE PROVIDED HEREUNDER IS
ON AN "AS IS" BASIS, AND THE COPYRIGHT HOLDER HAS NO OBLIGATION TO
PROVIDE MAINTENANCE, SUPPORT, UPDATES, ENHANCEMENTS, OR MODIFICATIONS.
```

## Unicode Character Database (text shaping)

- Source: the Unicode Character Database 18.0.0 (`Scripts.txt`, `ArabicShaping.txt`, `IndicSyllabicCategory.txt`, `IndicPositionalCategory.txt`, `BidiMirroring.txt`, `DerivedCoreProperties.txt`, `extracted/DerivedCombiningClass.txt`, `extracted/DerivedGeneralCategory.txt`; SHA-256 pinned in `src/scripts/shapingTables.ts`), https://www.unicode.org/Public/18.0.0/ucd/
- Copyright: © 1991-2026 Unicode, Inc.
- `src/core/pdfwrite/fonts/shaping.generated.ts` is generated from them by `src/scripts/shapingTables.ts` (re-encoded as run-length tables).
- Unicode CLDR 49 (Common Locale Data Repository), `common/supplemental/supplementalData.xml` `<currencyData>`, https://raw.githubusercontent.com/unicode-org/cldr/release-49/common/supplemental/supplementalData.xml (SHA-256 `745150ec1408d50e1a272b65654a5dd645f3e60f5cc2898b576f725b28538d1a`; release https://cldr.unicode.org/downloads/cldr-49), Copyright © 2001–2026 Unicode, Inc.: `src/core/sheet/input/currencies.generated.ts` is generated from it by `src/scripts/currencyTables.ts` (each territory's current currency as five-letter records). CLDR's data is released under the Unicode License v3 below (the repository's LICENSE, https://raw.githubusercontent.com/unicode-org/cldr/release-49/LICENSE, SHA-256 `65eb33419e22a297550a811b5b535f5e532f9a7e0114b516c0ea18afd53c3804`: "All other content in this repo is released under UNICODE LICENSE V3").
- Licence: Unicode License v3 (https://www.unicode.org/license.txt, SHA-256 `e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96`), reproduced verbatim:

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

## CodeMirror highlight styles

- Source: @codemirror/language 6.12.4 (`defaultHighlightStyle`) and @codemirror/theme-one-dark 6.1.3 (`oneDarkHighlightStyle`), https://github.com/codemirror
- Copyright: 2018-2021 Marijn Haverbeke and others
- Licence: MIT (text below)
- Derived files, modified for `@filen/office`:
  - `src/dom/code/theme.ts` (the two styles' colours, weights and decorations per highlight tag, as CSS variables)

```
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## LibreOffice locale data

- Source: LibreOffice 7.5.0.3 (`i18npool/source/localedata/data`, `svl` number format keywords, `scaddins/source/analysis`), https://www.libreoffice.org
- Copyright: The Document Foundation and the LibreOffice contributors
- Licence: Mozilla Public License 2.0 (notice below; full text at https://mozilla.org/MPL/2.0/); the source files also incorporate work under the Apache License 2.0 (notice below, text below)
- Derived files, modified for `@filen/office`:
  - `src/core/sheet/clipboard/libreOffice.ts` (per-locale decimal and group separators, the name of General and the localised number format keyword letters)
  - `src/core/sheet/formula/functions/bondMath.ts` (the bond and depreciation day-count arithmetic of the analysis add-in, where Microsoft's documentation gives no algorithm)

```
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.

This file incorporates work covered by the following license notice:

  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements. See the NOTICE file distributed
  with this work for additional information regarding copyright
  ownership. The ASF licenses this file to you under the Apache
  License, Version 2.0 (the "License"); you may not use this file
  except in compliance with the License. You may obtain a copy of
  the License at http://www.apache.org/licenses/LICENSE-2.0 .
```

## Hyphenation patterns (hyph-utf8)

- Source: hyph-utf8 at tex-hyphen `5684c0f51c0b81133db2efbe60a408b4155a3ff5`, https://github.com/hyphenation/tex-hyphen
- Copyright: the authors each file names, below
- Licence: each pattern file's own, from its header. Only files whose header grants a permissive licence (MIT, BSD-style, public domain or an all-permissive notice, alone or among the licences it offers) are bundled; LPPL-only, GPL-only and unlicensed ones are not, nor Basque's, whose licence asks for a notice inside each modified file. Files offering several licences are used under the MIT licence (text below). Each file's licence block is recorded verbatim, with its upstream URLs and both SHA-256 sums, in `assets/hyphenation/manifest.json`, which ships beside the files.
- Files: `assets/hyphenation/hyph-<language>.txt.gz`, the patterns of `txt/hyph-<language>.pat.txt` and the exceptions of `txt/hyph-<language>.hyp.txt` (space-separated, one line each), gzip-compressed and otherwise unchanged; written, with `src/core/text/hyphenation/languages.generated.ts`, by `src/scripts/hyphenationPatterns.ts`.
- Use: automatic hyphenation of Word and OpenDocument text documents (`src/core/text/hyphenation/`), a language fetched the first time a document hyphenates text in it.
- Languages, files, copyright and licence (SPDX):
  - Afrikaans: `hyph-af.txt.gz`; Copyright (C) 2013 Tilla Fick and Chris Swanepoel; MIT
  - Belarusian: `hyph-be.txt.gz`; Copyright (C) 2016 Maksim Salau; MIT
  - Bulgarian: `hyph-bg.txt.gz`; Copyright (C) 2000, 2004, 2017 Anton Zinoviev; LicenseRef-hyph-bg (BSD-style)
  - Welsh: `hyph-cy.txt.gz`; Copyright (C) 1996 Yannis Haralambous; MIT
  - Danish: `hyph-da.txt.gz`; Copyright (C) 1994 Frank Jensen; MIT
  - German (reformed spelling): `hyph-de-1996.txt.gz`; Copyright (c) 2013-2024 Stephan Hennig, Werner Lemberg, Günter Milde, Sander van Geloven, Georg Pfeiffer, Gisbert W. Selke, Tobias Wendorf, Keno Wehr; MIT
  - Greek (monotonic): `hyph-el-monoton.txt.gz`; Copyright (C) 2008-2011 Dimitrios Filippou; MIT
  - English (British): `hyph-en-gb.txt.gz`; Copyright (C) 1992, 1996, 2005, 2016 Dominik Wujastyk, Graham Toal; MIT
  - English (American): `hyph-en-us.txt.gz`; Copyright (C) 1990, 2004, 2005 Gerard D.C. Kuiken; FSFAP
  - Spanish: `hyph-es.txt.gz`; Copyright (C) 1993, 1997 Javier Bezos, 2001-2019 Javier Bezos, CervanTeX; MIT
  - Estonian: `hyph-et.txt.gz`; Copyright (C) 2004-2015 Enn Saar; MIT
  - French: `hyph-fr.txt.gz`; Copyright (C) 1994-2002 Daniel Flipo, Bernard Gaulle, 2016 Arthur Reutenauer; MIT
  - Irish: `hyph-ga.txt.gz`; Copyright (C) 2004-2015 Kevin P. Scannell; MIT
  - Galician: `hyph-gl.txt.gz`; Copyright (C) 2006, 2007, 2008, 2010 Javier A. Múgica; Unlicense
  - Italian: `hyph-it.txt.gz`; Copyright (C) 2008-2011 Claudio Beccari; MIT
  - Georgian: `hyph-ka.txt.gz`; Copyright (C) 2013 Levan Shoshiashvili; MIT
  - Kazakh: `hyph-kk.txt.gz`; Copyright (C) 2010 Mojca Miklavec, 2025 Robert Ermers, 2026 Arthur Rosendahl; LicenseRef-Public-Domain
  - Lithuanian: `hyph-lt.txt.gz`; Copyright (C) 1992 Sigitas Tolušis, Yannis Haralambous; MIT
  - Mongolian (Cyrillic): `hyph-mn-cyrl.txt.gz`; Copyright (C) 2007-2015 by Dorjgotov Batmunkh; MIT
  - Norwegian Bokmål: `hyph-nb.txt.gz`; Copyright (C) 2004, 2005 Rune Kleveland, Ole Michael Selberg; Copyright (C) 2004–2005 Rune Kleveland, Ole Michael Selberg, 2007 Karl Ove Hufthammer; FSFAP
  - Dutch: `hyph-nl.txt.gz`; Copyright (C) 1996 Piet Tutelaers; MIT
  - Norwegian Nynorsk: `hyph-nn.txt.gz`; Copyright (C) 2004, 2005 Rune Kleveland, Ole Michael Selberg; Copyright (C) 2007 Karl Ove Hufthammer; FSFAP
  - Occitan: `hyph-oc.txt.gz`; Copyright (C) 2016 Claudio Beccari; MIT
  - Polish: `hyph-pl.txt.gz`; Copyright (C) 1987-1995 Hanna Kołodziejska, Bogusław Jackowski, Marek Ryćko; MIT
  - Portuguese: `hyph-pt.txt.gz`; Copyright (C) 1987, 1994, 1996, 2015 Pedro J. de Rezende, 1996, 2015 J. Joao Dias Almeida, 2024 Leonardo Araujo and Aline Benevides; BSD-3-Clause
  - Romansh: `hyph-rm.txt.gz`; Copyright (C) 2012 Claudio Beccari, 2024 far.ch; MIT
  - Slovak: `hyph-sk.txt.gz`; Copyright (C) 1992 Jana Chlebíková; MIT
  - Slovenian: `hyph-sl.txt.gz`; Copyright (C) 1990 Matjaž Vrečko; MIT
  - Albanian: `hyph-sq.txt.gz`; Copyright (C) 2020 Claudio Beccari, Sabina Koliqi (C) 2025 Arthur Rosendahl; MIT
  - Turkmen: `hyph-tk.txt.gz`; Copyright (C) 2010-2015 Nazar Annagurban; MIT
  - Ukrainian: `hyph-uk.txt.gz`; Copyright (C) 1998-2001 Maksym Polyakov; MIT

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Bundled fonts (SIL Open Font License 1.1)

- Source: the upstream repositories and commits below; every file, its upstream URL and both SHA-256 sums are recorded in `assets/fonts/manifest.json`.
- Licence: SIL Open Font License, Version 1.1. Each family's licence text ships beside its files (`assets/fonts/<family>/OFL.txt`, Selawik `LICENSE.txt`) and must be served with them.
- Use: Carlito, Caladea, Arimo, Tinos, Cousine, Gelasio and Selawik draw documents that name Calibri, Cambria, Arial, Times New Roman, Courier New, Georgia and Segoe UI (`src/core/fonts/substitutes.ts`); their `.ttf.gz` faces and the Noto families are fetched only for PDF export.

### Substitutes

#### Carlito 1.104

- Source: https://github.com/googlefonts/carlito (`3a810cab78ebd6e2e4eed42af9e8453c4f9b850a`)
- Copyright: Copyright 2013 The Carlito Project Authors (https://github.com/googlefonts/carlito), with Reserved Font Name "Carlito"
- Licence: OFL-1.1 (`assets/fonts/carlito/OFL.txt`); Reserved Font Name "Carlito"
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/carlito/Carlito-Regular.woff2` `061d116e1dd01e0b61356a1717711ac681e839c968b800cb8ee3a5eb4e73c905`; upstream https://raw.githubusercontent.com/googlefonts/carlito/3a810cab78ebd6e2e4eed42af9e8453c4f9b850a/fonts/ttf/Carlito-Regular.ttf `f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595`; WOFF2-compressed, font data unchanged (not a Modified Version, OFL FAQ 2.2.1)
  - `assets/fonts/carlito/Carlito-Italic.woff2` `4f6241e74e08ddba83b5bc1ec4b8b2033375ed9ff6dc424511d5dd9c336f5cc3`; upstream https://raw.githubusercontent.com/googlefonts/carlito/3a810cab78ebd6e2e4eed42af9e8453c4f9b850a/fonts/ttf/Carlito-Italic.ttf `0b019225e58d702bfedcbd35c21696769f8ee115cb6343f84c2f240312450d1c`; WOFF2-compressed, font data unchanged (not a Modified Version, OFL FAQ 2.2.1)
  - `assets/fonts/carlito/Carlito-Bold.woff2` `6cb112074d0b2da2223dd93beaec10660a9cf6fb02ea71dc36224ce2d18a7ed8`; upstream https://raw.githubusercontent.com/googlefonts/carlito/3a810cab78ebd6e2e4eed42af9e8453c4f9b850a/fonts/ttf/Carlito-Bold.ttf `bb5d20f79b82599ec72983597437373a80f2d2085fa91fc144fd74e876a594db`; WOFF2-compressed, font data unchanged (not a Modified Version, OFL FAQ 2.2.1)
  - `assets/fonts/carlito/Carlito-BoldItalic.woff2` `09944164ea569abe2bc19db633fee60ab2d2eb67a12c3740aec2116d611c45db`; upstream https://raw.githubusercontent.com/googlefonts/carlito/3a810cab78ebd6e2e4eed42af9e8453c4f9b850a/fonts/ttf/Carlito-BoldItalic.ttf `b32928186c119599e03ca6a1ffc680fdcb7fac95772f4b95d989cf6cd3861517`; WOFF2-compressed, font data unchanged (not a Modified Version, OFL FAQ 2.2.1)
  - `assets/fonts/carlito/Carlito-Regular.ttf.gz` `95ef987010e277155c93d943f18314eb46aadefd4c91c7917ad070ab1523bdb4`; upstream https://raw.githubusercontent.com/googlefonts/carlito/3a810cab78ebd6e2e4eed42af9e8453c4f9b850a/fonts/ttf/Carlito-Regular.ttf `f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595`; gzip-compressed, font data unchanged
  - `assets/fonts/carlito/Carlito-Italic.ttf.gz` `37f25969e46a18d5b286b8e17409f79fa5b2414abef5bca4ec273d9926ac38b1`; upstream https://raw.githubusercontent.com/googlefonts/carlito/3a810cab78ebd6e2e4eed42af9e8453c4f9b850a/fonts/ttf/Carlito-Italic.ttf `0b019225e58d702bfedcbd35c21696769f8ee115cb6343f84c2f240312450d1c`; gzip-compressed, font data unchanged
  - `assets/fonts/carlito/Carlito-Bold.ttf.gz` `525e941c926a01240059071b69d4b3808455c2972a4cb1d768d6f5137bbcd51a`; upstream https://raw.githubusercontent.com/googlefonts/carlito/3a810cab78ebd6e2e4eed42af9e8453c4f9b850a/fonts/ttf/Carlito-Bold.ttf `bb5d20f79b82599ec72983597437373a80f2d2085fa91fc144fd74e876a594db`; gzip-compressed, font data unchanged
  - `assets/fonts/carlito/Carlito-BoldItalic.ttf.gz` `cc74941c6279902b35247b864908051e71e98c314aab763214fd2121b51ec1e1`; upstream https://raw.githubusercontent.com/googlefonts/carlito/3a810cab78ebd6e2e4eed42af9e8453c4f9b850a/fonts/ttf/Carlito-BoldItalic.ttf `b32928186c119599e03ca6a1ffc680fdcb7fac95772f4b95d989cf6cd3861517`; gzip-compressed, font data unchanged

#### Caladea 1.001

- Source: https://github.com/googlefonts/caladea (`336a529cfad3d103d6527752686f8331d13e820a`)
- Copyright: Copyright 2012 The Caladea Project Authors (https://github.com/huertatipografica/Caladea)
- Licence: OFL-1.1 (`assets/fonts/caladea/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/caladea/Caladea-Regular.woff2` `ff87986b38cf673033b9f2e5767e186580ebbdac8a8631fdd6a159a380f6d568`; upstream https://raw.githubusercontent.com/googlefonts/caladea/336a529cfad3d103d6527752686f8331d13e820a/fonts/ttf/Caladea-Regular.ttf `f1e899278b7b4491aba5b6a8253c4b04c050cc59b21865be5c37559a775153cd`; WOFF2-compressed, font data unchanged (not a Modified Version, OFL FAQ 2.2.1)
  - `assets/fonts/caladea/Caladea-Italic.woff2` `93288b02286710f775182c4f787fdd8da3142b9171b59d3d20eecfbac99ecfc5`; upstream https://raw.githubusercontent.com/googlefonts/caladea/336a529cfad3d103d6527752686f8331d13e820a/fonts/ttf/Caladea-Italic.ttf `4359a8e24f748b6447b1ff6d7a174febe70961d29f8bb8634b56dacd740a3deb`; WOFF2-compressed, font data unchanged (not a Modified Version, OFL FAQ 2.2.1)
  - `assets/fonts/caladea/Caladea-Bold.woff2` `19c917451b974c27ff8dd95ec45b898064632f2dfe90c2823a06e71bd81d1571`; upstream https://raw.githubusercontent.com/googlefonts/caladea/336a529cfad3d103d6527752686f8331d13e820a/fonts/ttf/Caladea-Bold.ttf `ae3cb2dcbc925809dd29d2a44e9802211cab66be541bacbfc9c08c74b27c3742`; WOFF2-compressed, font data unchanged (not a Modified Version, OFL FAQ 2.2.1)
  - `assets/fonts/caladea/Caladea-BoldItalic.woff2` `2907e7c21f11f1c6782e31329276d80d52e0dd2262126402bf4f032b1b897f02`; upstream https://raw.githubusercontent.com/googlefonts/caladea/336a529cfad3d103d6527752686f8331d13e820a/fonts/ttf/Caladea-BoldItalic.ttf `ccabaa7b7e2fdf253d2b1a5fa699dd8a3df8d835a9eb285ad82631a677eb76c0`; WOFF2-compressed, font data unchanged (not a Modified Version, OFL FAQ 2.2.1)
  - `assets/fonts/caladea/Caladea-Regular.ttf.gz` `333db46545dbc56bcd21426b6faf38c28ab386a2feb52651adbf8a6d072ee5b2`; upstream https://raw.githubusercontent.com/googlefonts/caladea/336a529cfad3d103d6527752686f8331d13e820a/fonts/ttf/Caladea-Regular.ttf `f1e899278b7b4491aba5b6a8253c4b04c050cc59b21865be5c37559a775153cd`; gzip-compressed, font data unchanged
  - `assets/fonts/caladea/Caladea-Italic.ttf.gz` `b662c0c5beef4f1a707292b6688040fda0e724aa764fb7c0c71fcb07b5c206da`; upstream https://raw.githubusercontent.com/googlefonts/caladea/336a529cfad3d103d6527752686f8331d13e820a/fonts/ttf/Caladea-Italic.ttf `4359a8e24f748b6447b1ff6d7a174febe70961d29f8bb8634b56dacd740a3deb`; gzip-compressed, font data unchanged
  - `assets/fonts/caladea/Caladea-Bold.ttf.gz` `991d2c9449743cea02ad463ac8b10954a0ec6291a9aa344d1e085a70d6279942`; upstream https://raw.githubusercontent.com/googlefonts/caladea/336a529cfad3d103d6527752686f8331d13e820a/fonts/ttf/Caladea-Bold.ttf `ae3cb2dcbc925809dd29d2a44e9802211cab66be541bacbfc9c08c74b27c3742`; gzip-compressed, font data unchanged
  - `assets/fonts/caladea/Caladea-BoldItalic.ttf.gz` `776eacaadc34b2fe17a27f830676477075933299ff5500f06120057d743efc1e`; upstream https://raw.githubusercontent.com/googlefonts/caladea/336a529cfad3d103d6527752686f8331d13e820a/fonts/ttf/Caladea-BoldItalic.ttf `ccabaa7b7e2fdf253d2b1a5fa699dd8a3df8d835a9eb285ad82631a677eb76c0`; gzip-compressed, font data unchanged

#### Arimo 1.341

- Source: https://github.com/googlefonts/arimo (`4a6255f269916ae7ad3fc2706b0935e7621396b8`)
- Copyright: Copyright 2026 The Arimo Project Authors (https://github.com/googlefonts/Arimo)
- Licence: OFL-1.1 (`assets/fonts/arimo/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/arimo/Arimo-VF.woff2` `0d2f65432c96632bd19360734af6c15d77a55c005e93356814ae7bc0461f2d5e`; upstream https://raw.githubusercontent.com/googlefonts/arimo/4a6255f269916ae7ad3fc2706b0935e7621396b8/fonts/webfonts/Arimo%5Bwght%5D.woff2 `0d2f65432c96632bd19360734af6c15d77a55c005e93356814ae7bc0461f2d5e`; unchanged
  - `assets/fonts/arimo/Arimo-Italic-VF.woff2` `a9d5da4ebfbe0ba41c284b440ac15dec375be0ba08079e9748ff49ff6ac0066d`; upstream https://raw.githubusercontent.com/googlefonts/arimo/4a6255f269916ae7ad3fc2706b0935e7621396b8/fonts/webfonts/Arimo-Italic%5Bwght%5D.woff2 `a9d5da4ebfbe0ba41c284b440ac15dec375be0ba08079e9748ff49ff6ac0066d`; unchanged
  - `assets/fonts/arimo/Arimo-Regular.ttf.gz` `2096961be1896d153ed20386276426976ed194c19bfdb6742cb046a8f97fe747`; upstream https://raw.githubusercontent.com/googlefonts/arimo/4a6255f269916ae7ad3fc2706b0935e7621396b8/fonts/variable/Arimo%5Bwght%5D.ttf `e43898b143ec826ac8cb4034816458a7047fbe0836558de2a1f8c6223ae3e0ca`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/arimo/Arimo-Italic.ttf.gz` `abbd4db007307131c7b0ea293aeb550a5416105b50c2c1ab0b87c77b2cd870a8`; upstream https://raw.githubusercontent.com/googlefonts/arimo/4a6255f269916ae7ad3fc2706b0935e7621396b8/fonts/variable/Arimo-Italic%5Bwght%5D.ttf `a80fc54fd0233c1dfe298577c4d00f5ae81d5bb83510975e473c47e699b7f4ed`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/arimo/Arimo-Bold.ttf.gz` `f3e5f39de381557a67a7feee797e2306d933453e8ff980b9843fda0817b5e971`; upstream https://raw.githubusercontent.com/googlefonts/arimo/4a6255f269916ae7ad3fc2706b0935e7621396b8/fonts/variable/Arimo%5Bwght%5D.ttf `e43898b143ec826ac8cb4034816458a7047fbe0836558de2a1f8c6223ae3e0ca`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/arimo/Arimo-BoldItalic.ttf.gz` `a9ce45bd389d0856c60cc3fb9db410c721f8a049c2b2402c0074543e9dd44d23`; upstream https://raw.githubusercontent.com/googlefonts/arimo/4a6255f269916ae7ad3fc2706b0935e7621396b8/fonts/variable/Arimo-Italic%5Bwght%5D.ttf `a80fc54fd0233c1dfe298577c4d00f5ae81d5bb83510975e473c47e699b7f4ed`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Tinos 1.340

- Source: https://github.com/googlefonts/tinos (`3b4482a99b80ea5fc75f187b1be3120a3f5905b3`)
- Copyright: Copyright 2026 The Tinos Project Authors (https://github.com/googlefonts/tinos)
- Licence: OFL-1.1 (`assets/fonts/tinos/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/tinos/Tinos-Regular.woff2` `990493259cd9f78dd1d1e7f697700bb450488968138251bb2c2c046d56a91548`; upstream https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/fonts/webfonts/Tinos-Regular.woff2 `990493259cd9f78dd1d1e7f697700bb450488968138251bb2c2c046d56a91548`; unchanged
  - `assets/fonts/tinos/Tinos-Italic.woff2` `28d3159c92e590181a0436105a6a508f3ac334ff9586bf1e9bac761d259e8860`; upstream https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/fonts/webfonts/Tinos-Italic.woff2 `28d3159c92e590181a0436105a6a508f3ac334ff9586bf1e9bac761d259e8860`; unchanged
  - `assets/fonts/tinos/Tinos-Bold.woff2` `cf4ba0b63a839e462c9461e86fb7c01fef1e734405ee403ec0121b7767b3f172`; upstream https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/fonts/webfonts/Tinos-Bold.woff2 `cf4ba0b63a839e462c9461e86fb7c01fef1e734405ee403ec0121b7767b3f172`; unchanged
  - `assets/fonts/tinos/Tinos-BoldItalic.woff2` `fe7ac295c7672860594e97cb66cec26f65dc0a76164e88696ef357335e4a2ad2`; upstream https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/fonts/webfonts/Tinos-BoldItalic.woff2 `fe7ac295c7672860594e97cb66cec26f65dc0a76164e88696ef357335e4a2ad2`; unchanged
  - `assets/fonts/tinos/Tinos-Regular.ttf.gz` `f3e70b5d5eaa5b37e2282d639a58eed394e7a4b68f66b4f3bf6d512bbccf3f94`; upstream https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/fonts/ttf/Tinos-Regular.ttf `60a0e8ef0c04dd5dd69ffe91025fa2ae5836cbd35600a82ba031977557e2cb61`; gzip-compressed, font data unchanged
  - `assets/fonts/tinos/Tinos-Italic.ttf.gz` `9280880bd6471e75a6b5d6a0a30ebefffe3a9928565c66ec7989715d399dbaec`; upstream https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/fonts/ttf/Tinos-Italic.ttf `5942266ed398b155d7dc23e36833e7ec6be988f2439bdbeb8ef1bede808eaa91`; gzip-compressed, font data unchanged
  - `assets/fonts/tinos/Tinos-Bold.ttf.gz` `05b7117e4fba1ca3dd31143f6a87881d093d39a56e5213e5b3ba6d0dc0a43357`; upstream https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/fonts/ttf/Tinos-Bold.ttf `393269dbab8899f938db19783eca5eac92eb431f7ae0ab45b8349ca895f1a06b`; gzip-compressed, font data unchanged
  - `assets/fonts/tinos/Tinos-BoldItalic.ttf.gz` `ef263fa33d382fb935e68c2c3125e3ace1d4cdfe8f74202daf4028ebc6d719e3`; upstream https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/fonts/ttf/Tinos-BoldItalic.ttf `a5de79f0fe863ea0954757acb3d47b3ccd0a930ce3dd5b97230cd3866790a06e`; gzip-compressed, font data unchanged

#### Cousine 1.241

- Source: https://github.com/googlefonts/cousine (`c0fbdb438443968c884a5c13f5f9bee916a7f89b`)
- Copyright: Copyright 2026 The Cousine Project Authors (https://github.com/googlefonts/cousine)
- Licence: OFL-1.1 (`assets/fonts/cousine/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/cousine/Cousine-Regular.woff2` `3882c5c1912dc7e218762381d93b0b22f20e97bc6aeee4864436fd34da6d6cf4`; upstream https://raw.githubusercontent.com/googlefonts/cousine/c0fbdb438443968c884a5c13f5f9bee916a7f89b/fonts/webfonts/Cousine-Regular.woff2 `3882c5c1912dc7e218762381d93b0b22f20e97bc6aeee4864436fd34da6d6cf4`; unchanged
  - `assets/fonts/cousine/Cousine-Italic.woff2` `5239caec66a180e1d9b8c9c74888660eb929b08027d1fb51ba207dae2b843188`; upstream https://raw.githubusercontent.com/googlefonts/cousine/c0fbdb438443968c884a5c13f5f9bee916a7f89b/fonts/webfonts/Cousine-Italic.woff2 `5239caec66a180e1d9b8c9c74888660eb929b08027d1fb51ba207dae2b843188`; unchanged
  - `assets/fonts/cousine/Cousine-Bold.woff2` `6e371376b51ca2828f9d39ba153c366cc29ba1a206cc4b21205e391e09362419`; upstream https://raw.githubusercontent.com/googlefonts/cousine/c0fbdb438443968c884a5c13f5f9bee916a7f89b/fonts/webfonts/Cousine-Bold.woff2 `6e371376b51ca2828f9d39ba153c366cc29ba1a206cc4b21205e391e09362419`; unchanged
  - `assets/fonts/cousine/Cousine-BoldItalic.woff2` `08accd82919cc9b3f2e73d100299084bb7af898472ef9c0293b92a207aec96d9`; upstream https://raw.githubusercontent.com/googlefonts/cousine/c0fbdb438443968c884a5c13f5f9bee916a7f89b/fonts/webfonts/Cousine-BoldItalic.woff2 `08accd82919cc9b3f2e73d100299084bb7af898472ef9c0293b92a207aec96d9`; unchanged
  - `assets/fonts/cousine/Cousine-Regular.ttf.gz` `7f19da2d7a5ab31ae30921770a5d7c6ec409b90371d82459118f29b9c2baaac9`; upstream https://raw.githubusercontent.com/googlefonts/cousine/c0fbdb438443968c884a5c13f5f9bee916a7f89b/fonts/ttf/Cousine-Regular.ttf `5a57f0184000371cb22fe3fcea4c500354cab1a69efaf7beaf3e6eca6ecfefea`; gzip-compressed, font data unchanged
  - `assets/fonts/cousine/Cousine-Italic.ttf.gz` `08c4c84f788dddacc368135821b21e69361efda1c1ad62e02b7c4a36190f15e7`; upstream https://raw.githubusercontent.com/googlefonts/cousine/c0fbdb438443968c884a5c13f5f9bee916a7f89b/fonts/ttf/Cousine-Italic.ttf `afb869eee8643d09915c3286edb61dad66278ceb1511c79b474ce21548421bcd`; gzip-compressed, font data unchanged
  - `assets/fonts/cousine/Cousine-Bold.ttf.gz` `d06e65667d7324101e7754aa47ac975968d76f5fa5ff6dd59996a85366267086`; upstream https://raw.githubusercontent.com/googlefonts/cousine/c0fbdb438443968c884a5c13f5f9bee916a7f89b/fonts/ttf/Cousine-Bold.ttf `331215ec6445f41e98d8971251bb6237e722907f4101faae990583accfe79545`; gzip-compressed, font data unchanged
  - `assets/fonts/cousine/Cousine-BoldItalic.ttf.gz` `6316d9b4d38e0e2581d7fee09e38941dda0b85a559bb2722aeef7710998cd84b`; upstream https://raw.githubusercontent.com/googlefonts/cousine/c0fbdb438443968c884a5c13f5f9bee916a7f89b/fonts/ttf/Cousine-BoldItalic.ttf `7f804549c941ceaac0a9635389ed09c4bbc86e4bfe37589191dacd1b5b0e26a5`; gzip-compressed, font data unchanged

#### Gelasio 1.008

- Source: https://github.com/SorkinType/Gelasio (`9228e69b160d79f33950e026293f6e13ba9780d0`)
- Copyright: Copyright 2022 The Gelasio Project Authors (https://github.com/SorkinType/Gelasio)
- Licence: OFL-1.1 (`assets/fonts/gelasio/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/gelasio/Gelasio-VF.woff2` `15a06d2088bbfcf250296c770704cb9bb3f229ff58289faf708fe0f3279094c3`; upstream https://raw.githubusercontent.com/SorkinType/Gelasio/9228e69b160d79f33950e026293f6e13ba9780d0/fonts/webfonts/Gelasio%5Bwght%5D.woff2 `15a06d2088bbfcf250296c770704cb9bb3f229ff58289faf708fe0f3279094c3`; unchanged
  - `assets/fonts/gelasio/Gelasio-Italic-VF.woff2` `91164b31301c9e72922371df0ce81334d3c68e44172fc8ef597ad63c873e9215`; upstream https://raw.githubusercontent.com/SorkinType/Gelasio/9228e69b160d79f33950e026293f6e13ba9780d0/fonts/webfonts/Gelasio-Italic%5Bwght%5D.woff2 `91164b31301c9e72922371df0ce81334d3c68e44172fc8ef597ad63c873e9215`; unchanged
  - `assets/fonts/gelasio/Gelasio-Regular.ttf.gz` `f0a3192cd1e77aebb931e4720c8362765d9b589d6107ff0cbba0dded8d62009e`; upstream https://raw.githubusercontent.com/SorkinType/Gelasio/9228e69b160d79f33950e026293f6e13ba9780d0/fonts/variable/Gelasio%5Bwght%5D.ttf `4daecea457258c9ebeb8bc99ed3fd24353618bfad3ea4b93fa0b5d0468fc04e4`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/gelasio/Gelasio-Italic.ttf.gz` `2a97f249932fad0b48e7f2fe7cf3dab8b105bd3fbab4d3718dbb3d21e5633b5c`; upstream https://raw.githubusercontent.com/SorkinType/Gelasio/9228e69b160d79f33950e026293f6e13ba9780d0/fonts/variable/Gelasio-Italic%5Bwght%5D.ttf `52559e845a4d33514e5f93bb9ae7dbeae1894a53f2c565a15f18af40cd337c09`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/gelasio/Gelasio-Bold.ttf.gz` `ca41d1c77ddd6a0e2e425ac119eb51f6d78e38d95aab3f16f87d5ba16127cf21`; upstream https://raw.githubusercontent.com/SorkinType/Gelasio/9228e69b160d79f33950e026293f6e13ba9780d0/fonts/variable/Gelasio%5Bwght%5D.ttf `4daecea457258c9ebeb8bc99ed3fd24353618bfad3ea4b93fa0b5d0468fc04e4`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/gelasio/Gelasio-BoldItalic.ttf.gz` `81ed8335eb2225d843802685c94b7de3acb78ad7912db9abb9f21ed23587a295`; upstream https://raw.githubusercontent.com/SorkinType/Gelasio/9228e69b160d79f33950e026293f6e13ba9780d0/fonts/variable/Gelasio-Italic%5Bwght%5D.ttf `52559e845a4d33514e5f93bb9ae7dbeae1894a53f2c565a15f18af40cd337c09`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Selawik 1.01

- Source: https://github.com/microsoft/Selawik (`89362e84731d1f5777fa078fd4d5ebbd339e4378`); release archive https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip (SHA-256 `3f62c51e05e3b5a1e6241cf92a371f0be2ea1183aa87b30718bbd40832a8d423`)
- Copyright: Copyright 2015, Microsoft Corporation (www.microsoft.com), with Reserved Font Name Selawik.  All Rights Reserved.  Selawik is a trademark of Microsoft Corporation in the United States and/or other countries.
- Licence: OFL-1.1 (`assets/fonts/selawik/LICENSE.txt`); Reserved Font Name "Selawik"
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/selawik/selawkl.woff2` `0ed6f426d9e1bcd65c40c13f1f9a900279d36db104c3927a4cde03f1dd4bf687`; upstream ? `?`; unchanged
  - `assets/fonts/selawik/selawksl.woff2` `3ddb97e4892003dfd87daf5ec9cb49f1a182289b706c813b3c50dfc18c51c07e`; upstream ? `?`; unchanged
  - `assets/fonts/selawik/selawk.woff2` `0f11afe1e85c8fd5d35d33e0142bd140e460a48cf3b42317d0c34e40c2b7118b`; upstream ? `?`; unchanged
  - `assets/fonts/selawik/selawksb.woff2` `83767c05ef6b99e054a20e85ed538223c3d3147fd3bea8c372ca9c46764d8c5b`; upstream ? `?`; unchanged
  - `assets/fonts/selawik/selawkb.woff2` `e8e9896309b2b003e2eefca4c51f82d2d3fb693a440cb969dd0650f0d5070012`; upstream ? `?`; unchanged
  - `assets/fonts/selawik/selawkl.ttf.gz` `cdfbb60970ab1bf39ecb852bca099b6a82321f177395f9e6747e46ef15f32f3e`; upstream https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip `8e19d073091a1e869b5b0d48b925e605c0a4c6ece7df7b22a364fb065314c4c5`; gzip-compressed, font data unchanged
  - `assets/fonts/selawik/selawksl.ttf.gz` `c05b1a2b3439a96dd96987d8467ab08e0409d39ef6c7ad09259646befd6284c8`; upstream https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip `8620960344f12093482cded984a1aafa5a57d24cbf7e9299da125ccf0e9d4102`; gzip-compressed, font data unchanged
  - `assets/fonts/selawik/selawk.ttf.gz` `5a9cb4b53dd9e1f52838f7925a3ebb81abbbfa0dcfdeae1e52e7dd48728f7dcb`; upstream https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip `e9d98518d8ac2817782a9a382430463a2e0793ea68350b695bb727d9a830ee1c`; gzip-compressed, font data unchanged
  - `assets/fonts/selawik/selawksb.ttf.gz` `5a6aeabe18f871e532598f1a1269aacdf354600c2905556c1c1939c49dc07304`; upstream https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip `0a9e9d0549a10f24bef9b3a29e06fe6e0b5c21e7a784c503b048a307841a7783`; gzip-compressed, font data unchanged
  - `assets/fonts/selawik/selawkb.ttf.gz` `85d4e31f3fd3ed1f05f0a9fc23e8ee552594055d8f6de8572a0811493f02d555`; upstream https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip `f0db5e174a90e0956ad7d2844bdca1d5e6da92ec65b2c04e57ba9b180668c904`; gzip-compressed, font data unchanged

### PDF fallbacks (Noto)

#### Noto Naskh Arabic 2.021

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notonaskharabic
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-naskh-arabic/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-naskh-arabic/NotoNaskhArabic-Regular.ttf.gz` `03d355878ba2f9cc58d047b7f6719a1c3211af7d4f58259aad321e0437a970c3`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf `67b5a525a661b607971fbd3f96a81b89d3a768e74534fca84f18ac97e6fab72f`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-naskh-arabic/NotoNaskhArabic-Bold.ttf.gz` `eaa7977efd77196d485592dba7583ab4744257249415d790c54f668f4b53047b`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf `67b5a525a661b607971fbd3f96a81b89d3a768e74534fca84f18ac97e6fab72f`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Hebrew 3.001

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanshebrew
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/hebrew)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-hebrew/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-hebrew/NotoSansHebrew-Regular.ttf.gz` `4a45cfbe531d4f9c27eafc13621e7f936dbf2e029a49a07fd02bfd71e97951f3`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf `7ef36a2c3593758cdb622e1bdef4f84523e92fbc3ccc667438dd80ff54c2de88`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-hebrew/NotoSansHebrew-Bold.ttf.gz` `ad6a5421b92e85ad2ba46d4f7e2367c54e51b50b0f5e75881511bc6cbcf01067`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanshebrew/NotoSansHebrew%5Bwdth%2Cwght%5D.ttf `7ef36a2c3593758cdb622e1bdef4f84523e92fbc3ccc667438dd80ff54c2de88`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Armenian 2.008

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansarmenian
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/armenian)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-armenian/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-armenian/NotoSansArmenian-Regular.ttf.gz` `5fe08aa0091087ac36d2ed39add39b34d3122a38fa752d3aeb6eb021ae7ca895`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansarmenian/NotoSansArmenian%5Bwdth%2Cwght%5D.ttf `0870908d8318435a5daf1cd280ae15063f990cd9ad60f3e94c734ce9e1ffef71`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-armenian/NotoSansArmenian-Bold.ttf.gz` `225fb3d50663d783a3bf8a933ba8f2e8da95149e9766e0987354ba08045e64d8`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansarmenian/NotoSansArmenian%5Bwdth%2Cwght%5D.ttf `0870908d8318435a5daf1cd280ae15063f990cd9ad60f3e94c734ce9e1ffef71`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Georgian 2.005

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansgeorgian
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/georgian)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-georgian/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-georgian/NotoSansGeorgian-Regular.ttf.gz` `2825804006f63df98b0b954a73a78097cb5b244ca8210824f708164624b8dbfd`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansgeorgian/NotoSansGeorgian%5Bwdth%2Cwght%5D.ttf `dc591156f36842d38996c4a7a17fee9bb58e45da3e2cac7a31b7d33de700adb9`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-georgian/NotoSansGeorgian-Bold.ttf.gz` `4bc5fd76b5ca20be819ab7ca0a41753967486df96b265773959149f2dfd308cc`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansgeorgian/NotoSansGeorgian%5Bwdth%2Cwght%5D.ttf `dc591156f36842d38996c4a7a17fee9bb58e45da3e2cac7a31b7d33de700adb9`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Ethiopic 2.102

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansethiopic
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/ethiopic)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-ethiopic/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-ethiopic/NotoSansEthiopic-Regular.ttf.gz` `0254b300d94ccfb3a791af571ba29f156ed59aa913686a343bd2ae8d031d8bab`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansethiopic/NotoSansEthiopic%5Bwdth%2Cwght%5D.ttf `0dbccc00b22d180ebd6a4bd8a733918a29e709fa6798023adc3e6cd40da65077`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-ethiopic/NotoSansEthiopic-Bold.ttf.gz` `688a874d0901cc133a791fc44d76f245e62cfd4313c3ee0a381ceb69a83b1342`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansethiopic/NotoSansEthiopic%5Bwdth%2Cwght%5D.ttf `0dbccc00b22d180ebd6a4bd8a733918a29e709fa6798023adc3e6cd40da65077`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Devanagari 2.007

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansdevanagari
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/devanagari)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-devanagari/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-devanagari/NotoSansDevanagari-Regular.ttf.gz` `ca0c19c1f51401718aa2f83bea818ff6770ca5568872f0260903075a45613850`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf `14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-devanagari/NotoSansDevanagari-Bold.ttf.gz` `f9686c8eacc95446589bbcf1c88cd5cd34ae85c42776f961ce3c1ce9ee2c9c41`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansdevanagari/NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf `14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Bengali 3.011

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansbengali
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/bengali)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-bengali/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-bengali/NotoSansBengali-Regular.ttf.gz` `535e25219937e4c12d3525753e0e9c50a99f8895f4a8d4d46c9444f8cbfd0664`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansbengali/NotoSansBengali%5Bwdth%2Cwght%5D.ttf `dcd42978094e584a849c84a51450eeac40c8826057d566ea6d4b9627a403a05a`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-bengali/NotoSansBengali-Bold.ttf.gz` `2021e487e610b2d06ae4f7910e4491cb7af31d54307cd888e1fa5b30f463640e`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansbengali/NotoSansBengali%5Bwdth%2Cwght%5D.ttf `dcd42978094e584a849c84a51450eeac40c8826057d566ea6d4b9627a403a05a`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Gurmukhi 2.004

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansgurmukhi
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gurmukhi)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-gurmukhi/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-gurmukhi/NotoSansGurmukhi-Regular.ttf.gz` `ea3196b56f1413144539f70d10d2a8ccf93d4a15242d5acf7a804b604ade8d33`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansgurmukhi/NotoSansGurmukhi%5Bwdth%2Cwght%5D.ttf `1e6f728fa620e566f842d81e220265813faa12771214765d289c98e035adc5f2`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-gurmukhi/NotoSansGurmukhi-Bold.ttf.gz` `2c612253c5d809a6c9262e77caca82d56c722fdc4424730f55e79fd9bb4c41db`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansgurmukhi/NotoSansGurmukhi%5Bwdth%2Cwght%5D.ttf `1e6f728fa620e566f842d81e220265813faa12771214765d289c98e035adc5f2`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Gujarati 2.106

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansgujarati
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/gujarati)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-gujarati/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-gujarati/NotoSansGujarati-Regular.ttf.gz` `bf88e038e5179573de9e091419f445e52adaeb3594c1d1d2288b686a8fc80933`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansgujarati/NotoSansGujarati%5Bwdth%2Cwght%5D.ttf `9901d8552f1dd5d2c50dbd4caa6f6e174e74e8264f06594ab259ae6e7b1ac428`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-gujarati/NotoSansGujarati-Bold.ttf.gz` `0da4fda4da7ed26df173618372a828531a3ac86eb3dafc3183cf9565049f4c82`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansgujarati/NotoSansGujarati%5Bwdth%2Cwght%5D.ttf `9901d8552f1dd5d2c50dbd4caa6f6e174e74e8264f06594ab259ae6e7b1ac428`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Oriya 2.007

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansoriya
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/oriya)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-oriya/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-oriya/NotoSansOriya-Regular.ttf.gz` `bb737c400ad5b7eb432e0ebb4b18ec953da3b0c17ca67ebe829afd16360a6779`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansoriya/NotoSansOriya%5Bwdth%2Cwght%5D.ttf `910342275d619081b896b4ed25fd9ad6ff320c25591b810de1fcc4beb153ba82`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-oriya/NotoSansOriya-Bold.ttf.gz` `f81c5a11b7ee3ffba86e8e00d4dd00a1821f9ea3c21ceda151a9e34b0a03a404`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansoriya/NotoSansOriya%5Bwdth%2Cwght%5D.ttf `910342275d619081b896b4ed25fd9ad6ff320c25591b810de1fcc4beb153ba82`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Tamil 2.004

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanstamil
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/tamil)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-tamil/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-tamil/NotoSansTamil-Regular.ttf.gz` `8f916206e38e06a7cab2732bd8b3ebd950be1549cc7abc67b52fe1f550b72490`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanstamil/NotoSansTamil%5Bwdth%2Cwght%5D.ttf `aa3a9b321f4b0bb2c40203ffbde9af89713227866e0e13f76e5b9eeea727cf88`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-tamil/NotoSansTamil-Bold.ttf.gz` `6c98c9329b4892a9b18f90c4485f332960f01f67559f721e5762d83924d4d444`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanstamil/NotoSansTamil%5Bwdth%2Cwght%5D.ttf `aa3a9b321f4b0bb2c40203ffbde9af89713227866e0e13f76e5b9eeea727cf88`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Telugu 2.005

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanstelugu
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/telugu)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-telugu/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-telugu/NotoSansTelugu-Regular.ttf.gz` `f62b060a2a7a7d2b6210d62c5bd45a4b71593e8976e0fdbe5c3eb6596acd4341`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanstelugu/NotoSansTelugu%5Bwdth%2Cwght%5D.ttf `e618af7bf999df192ed4f388eba2e563f2b5015034e9cbb317b5bd793bd7334d`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-telugu/NotoSansTelugu-Bold.ttf.gz` `a76fcd667e09aa0f1199c02c5306ce27221c5c845189afb795ed39645c8d47e1`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanstelugu/NotoSansTelugu%5Bwdth%2Cwght%5D.ttf `e618af7bf999df192ed4f388eba2e563f2b5015034e9cbb317b5bd793bd7334d`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Kannada 2.006

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanskannada
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/kannada)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-kannada/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-kannada/NotoSansKannada-Regular.ttf.gz` `8126e85a5761c042315ffa22d26a7d562edf2d668283ea2e2d757b03fd097cff`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanskannada/NotoSansKannada%5Bwdth%2Cwght%5D.ttf `cca4f3b3a8cb12fb261f1b43baf5d2f7f59d90fe123d41f0065ed3a183997ec9`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-kannada/NotoSansKannada-Bold.ttf.gz` `1e2a9dda79beab91c2a06c1ed4baaf8e38d082093c01f686c4aab9da69d35156`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanskannada/NotoSansKannada%5Bwdth%2Cwght%5D.ttf `cca4f3b3a8cb12fb261f1b43baf5d2f7f59d90fe123d41f0065ed3a183997ec9`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Malayalam 2.104

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansmalayalam
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/malayalam)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-malayalam/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-malayalam/NotoSansMalayalam-Regular.ttf.gz` `4cca6661cfd5aa4b23cbdae7a736fcbdf9331d1907ddcd95d8edccecc9eab9b3`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansmalayalam/NotoSansMalayalam%5Bwdth%2Cwght%5D.ttf `312e0e7c3cc15fa09eb42a8f749eeb246b593ed420e3c81aafe8d910c3a6fb56`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-malayalam/NotoSansMalayalam-Bold.ttf.gz` `5862275c436a416893e3484693f55df295287f30ecf71ebd2195ee86a1130c91`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansmalayalam/NotoSansMalayalam%5Bwdth%2Cwght%5D.ttf `312e0e7c3cc15fa09eb42a8f749eeb246b593ed420e3c81aafe8d910c3a6fb56`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Sinhala 2.006

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanssinhala
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/sinhala)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-sinhala/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-sinhala/NotoSansSinhala-Regular.ttf.gz` `4ceb4665b9e4073c51f3fd21ef8e6b2ae0593ff9956eb6c051e52031d7d6f509`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanssinhala/NotoSansSinhala%5Bwdth%2Cwght%5D.ttf `9bd93e407a278075be403324063bc94a7e306c44de4df81214e932330c22eecf`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-sinhala/NotoSansSinhala-Bold.ttf.gz` `534d16bf84b51bd50b0ddccd42b8bf12a85ac615b7c5e5eeb5feef98d6e87c5f`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanssinhala/NotoSansSinhala%5Bwdth%2Cwght%5D.ttf `9bd93e407a278075be403324063bc94a7e306c44de4df81214e932330c22eecf`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Thai 2.002

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansthai
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/thai)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-thai/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-thai/NotoSansThai-Regular.ttf.gz` `ac2a2343b87089d96be610d2216f0dfbc063e2786bc0cfe90573d7675de3ef18`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansthai/NotoSansThai%5Bwdth%2Cwght%5D.ttf `5a1c559bb539583c8a1fd99d1c5b9491e5e14478c9cd2bd0970d5c3096cc9ef8`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-thai/NotoSansThai-Bold.ttf.gz` `592f15903d210f796aa2c049440852902ea24f02b914c533d3d314efa72f1747`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansthai/NotoSansThai%5Bwdth%2Cwght%5D.ttf `5a1c559bb539583c8a1fd99d1c5b9491e5e14478c9cd2bd0970d5c3096cc9ef8`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Lao 2.003

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanslao
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/lao)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-lao/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-lao/NotoSansLao-Regular.ttf.gz` `2aaf97233cf3c3b9fc70c65ba3679fa682c34d6cb3646b2abe65268153653026`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanslao/NotoSansLao%5Bwdth%2Cwght%5D.ttf `9608b94603a82d09a8038946f9775242f99e3b3459b7f1e4d5b335b578cd7ab3`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)
  - `assets/fonts/noto/noto-sans-lao/NotoSansLao-Bold.ttf.gz` `e507a13be88cc6efdea4d5068fd0fba4bd6e5295977dbbb3ef28095e3aa82032`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanslao/NotoSansLao%5Bwdth%2Cwght%5D.ttf `9608b94603a82d09a8038946f9775242f99e3b3459b7f1e4d5b335b578cd7ab3`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans SC 2.004

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanssc
- Copyright: Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-sc/OFL.txt`); Reserved Font Name "Source"
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-sc/NotoSansSC-Regular.ttf.gz` `ade97f77004fc4364379272592a06a7d7a951748694195bf5684399a47f13c70`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans TC 2.004

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanstc
- Copyright: Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-tc/OFL.txt`); Reserved Font Name "Source"
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-tc/NotoSansTC-Regular.ttf.gz` `d5c161308a78ca32ad090cee655af9dad60f5b8010dc14e9bd4229883207a0f8`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf `864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans JP 2.004

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansjp
- Copyright: Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-jp/OFL.txt`); Reserved Font Name "Source"
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-jp/NotoSansJP-Regular.ttf.gz` `e27ae5d5956931e052884d2477774ba8a5e6d4a98ea0a0bffaedcd8477f6ad33`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf `c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans KR 2.004

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanskr
- Copyright: Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-kr/OFL.txt`); Reserved Font Name "Source"
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-kr/NotoSansKR-Regular.ttf.gz` `80a1106a71f586b26deae45bdcd766db999c63f7d439ae876081528ba2e98d22`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252`; static instance of the upstream variable font, gzip-compressed (a Modified Version under the OFL)

#### Noto Sans Symbols 2 2.008

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanssymbols2
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/symbols)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-symbols-2/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-symbols-2/NotoSansSymbols2-Regular.ttf.gz` `6df8c983b114ea4863ad184e94d35a3c005abf829cb920401dfbc49614dfb746`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosanssymbols2/NotoSansSymbols2-Regular.ttf `7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21`; gzip-compressed, font data unchanged

#### Noto Sans Math 3.000

- Source: https://github.com/google/fonts/tree/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansmath
- Copyright: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/math)
- Licence: OFL-1.1 (`assets/fonts/noto/noto-sans-math/OFL.txt`); no Reserved Font Name
- Files (SHA-256 of the shipped file; of the upstream file):
  - `assets/fonts/noto/noto-sans-math/NotoSansMath-Regular.ttf.gz` `7477333a44fc39c8432ab811a4c35fbccff446eccab415b9771d5144658b4fce`; upstream https://raw.githubusercontent.com/google/fonts/45e3d5269e4a17d823f6d84470bc084dc5ae46f6/ofl/notosansmath/NotoSansMath-Regular.ttf `3f495fe933c06786e4d5f6d86b8ee70b6753a68ee3b9d87528726de0f6e2c47d`; gzip-compressed, font data unchanged

## Apache License 2.0

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright (c) 2016-2023 Volodymyr Baydalka

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
