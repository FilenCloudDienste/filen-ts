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
- `src/core/doc/toDocx/officeArt.ts` holds the record types of §2.2 and the property ids of §2.3 it reads (re-encoded as constants, not copied), under the same permission. `src/core/doc/toDocx/convert.ts` implements the shape properties it converts from the specification; none of its text is copied.
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
