// Builds a formatted Excel workbook (.xlsx) for a report, in the browser, with no
// library: an .xlsx file is a zip of a few XML files. The sheet has a letterhead,
// a summary box, a table with a coloured header, zebra rows, peso amounts kept as
// real numbers (so Excel can still add them), a TOTAL row with SUM formulas, column
// widths that fit, a frozen header with filters, and print set to landscape, one
// page wide, with signature lines at the end.
//
// window.olvReportXlsx({ title, description, address, coverage, generated, preparedBy,
//   summary: [[label, value]], columns: [{ label, type, total }], rows: [[cell values]] }) -> Blob
// Column types: "money", "number", anything else is text.
(() => {
    const STYLE = {
        normal: 0, station: 1, muted: 2, reportTitle: 3, metaLabel: 4, metaValue: 5, header: 6, headerNum: 7,
        text: 8, textZebra: 9, money: 10, moneyZebra: 11, number: 12, numberZebra: 13,
        totalLabel: 14, totalMoney: 15, totalNumber: 16, totalEmpty: 17,
        summaryLabel: 18, summaryValue: 19, signLine: 20, signCaption: 21
    };
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;₱&quot;#,##0.00"/></numFmts>
<fonts count="8">
<font><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="16"/><color rgb="FF0B2540"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF5D6F82"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="13"/><color rgb="FF0A4F80"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font>
<font><sz val="10"/><color rgb="FF1F2937"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><color rgb="FF0B2540"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0B6FB3"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3F8FC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE3EEF8"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="4">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD7E3EE"/></left><right style="thin"><color rgb="FFD7E3EE"/></right><top style="thin"><color rgb="FFD7E3EE"/></top><bottom style="thin"><color rgb="FFD7E3EE"/></bottom><diagonal/></border>
<border><left style="thin"><color rgb="FFD7E3EE"/></left><right style="thin"><color rgb="FFD7E3EE"/></right><top style="medium"><color rgb="FF0B6FB3"/></top><bottom style="medium"><color rgb="FF0B6FB3"/></bottom><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF1F2937"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="22">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1" indent="1"/></xf>
<xf numFmtId="0" fontId="6" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1" indent="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1" indent="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1" indent="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="3" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="7" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="1"/></xf>
<xf numFmtId="164" fontId="7" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="3" fontId="7" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="7" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="7" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" indent="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="3" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="bottom"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

    const xmlText = value => String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
        // Characters XML cannot hold at all.
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    const colName = index => { let name = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; };
    const ref = (col, row) => colName(col) + row;

    function build(report) {
        const columns = report.columns;
        const last = Math.max(columns.length, 4) - 1; // letterhead spans at least 4 columns
        const rows = [];              // { r, height, cells: [xml] }
        const merges = [];
        let r = 0;
        const addRow = (cells, height) => { r += 1; rows.push({ r, height, cells: cells.map(cell => cell(r)) }); return r; };
        const text = (col, value, style) => row => `<c r="${ref(col, row)}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
        const num = (col, value, style) => row => `<c r="${ref(col, row)}" s="${style}"><v>${Number(value) || 0}</v></c>`;
        const blank = (col, style) => row => `<c r="${ref(col, row)}" s="${style}"/>`;
        const wide = (value, style, height) => { const row = addRow([text(0, value, style)], height); merges.push(`A${row}:${colName(last)}${row}`); };

        // Letterhead
        wide("OLV Water Refilling Station", STYLE.station, 26);
        wide(report.address, STYLE.muted, 16);
        addRow([], 8);
        wide(report.title.toUpperCase(), STYLE.reportTitle, 22);
        if (report.description) wide(report.description, STYLE.muted, 16);
        addRow([], 6);
        for (const [label, value] of [["Coverage", report.coverage], ["Generated", report.generated], ["Prepared by", report.preparedBy]]) {
            const row = addRow([text(0, `${label}:`, STYLE.metaLabel), text(1, value || "-", STYLE.metaValue)], 16);
            merges.push(`B${row}:${colName(last)}${row}`);
        }
        addRow([], 10);

        // Summary box (two columns: label | value)
        // Values are shown as written on the report (e.g. "₱76,445.00", "26").
        for (const [label, value] of report.summary || []) {
            addRow([text(0, label, STYLE.summaryLabel), text(1, typeof value === "number" ? value.toLocaleString("en-PH") : value, STYLE.summaryValue)], 18);
        }
        addRow([], 12);

        // Table
        const headerRow = addRow(columns.map((column, col) => text(col, column.label, ["money", "number"].includes(column.type) ? STYLE.headerNum : STYLE.header)), 24);
        const firstData = headerRow + 1;
        report.rows.forEach((values, index) => {
            const zebra = index % 2 === 1;
            addRow(columns.map((column, col) => {
                const value = values[col];
                if (column.type === "money") return num(col, value, zebra ? STYLE.moneyZebra : STYLE.money);
                if (column.type === "number" && value !== "" && value !== null && value !== undefined && !Number.isNaN(Number(value))) return num(col, value, zebra ? STYLE.numberZebra : STYLE.number);
                return text(col, value ?? "-", zebra ? STYLE.textZebra : STYLE.text);
            }), 18);
        });
        const lastData = r;
        if (columns.some(column => column.total)) {
            addRow(columns.map((column, col) => {
                if (column.total) {
                    const total = report.rows.reduce((sum, values) => sum + (Number(values[col]) || 0), 0);
                    const range = `${ref(col, firstData)}:${ref(col, lastData)}`;
                    return row => `<c r="${ref(col, row)}" s="${column.type === "money" ? STYLE.totalMoney : STYLE.totalNumber}"><f>SUM(${range})</f><v>${Math.round(total * 100) / 100}</v></c>`;
                }
                return col === 0 ? text(0, "TOTAL", STYLE.totalLabel) : blank(col, STYLE.totalEmpty);
            }), 22);
        }

        // Signature lines
        addRow([], 30);
        // "Prepared by" under the first two columns, "Noted by (Owner)" at the right end,
        // always with at least one empty column between the two lines.
        const left = [0, 1], right = last - 1 > 2 ? [last - 1, last] : [last, last];
        const signRow = addRow([text(left[0], report.preparedBy || "", STYLE.signLine), blank(left[1], STYLE.signLine),
            blank(right[0], STYLE.signLine), ...(right[1] !== right[0] ? [blank(right[1], STYLE.signLine)] : [])], 20);
        const captionRow = addRow([text(left[0], "Prepared by", STYLE.signCaption), text(right[0], "Noted by (Owner)", STYLE.signCaption)], 16);
        for (const row of [signRow, captionRow]) {
            merges.push(`${ref(left[0], row)}:${ref(left[1], row)}`);
            if (right[1] !== right[0]) merges.push(`${ref(right[0], row)}:${ref(right[1], row)}`);
        }

        // Column widths from the longest value (wrapped text is capped).
        const widths = columns.map((column, col) => {
            const longest = Math.max(column.label.length, ...report.rows.map(values => {
                const value = values[col];
                return column.type === "money" ? `₱${(Number(value) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2 })}`.length + 1 : String(value ?? "-").length;
            }));
            return Math.min(48, Math.max(10, longest + 5)); // + room for the inner padding
        });
        while (widths.length <= last) widths.push(12);
        widths[0] = Math.max(widths[0], 16); // room for "Prepared by:" and the summary labels
        widths[1] = Math.max(widths[1], 18);

        const sheetRows = rows.map(row => `<row r="${row.r}"${row.height ? ` ht="${row.height}" customHeight="1"` : ""}>${row.cells.sort((a, b) => cellCol(a) - cellCol(b)).join("")}</row>`).join("");
        const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${ref(last, r)}"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headerRow}" topLeftCell="A${firstData}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${firstData}" sqref="A${firstData}"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((width, col) => `<col min="${col + 1}" max="${col + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>
<sheetData>${sheetRows}</sheetData>
${report.rows.length ? `<autoFilter ref="A${headerRow}:${ref(columns.length - 1, lastData)}"/>` : ""}
<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>
<printOptions horizontalCentered="1"/>
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;L${xmlText(report.title)}&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter>
</worksheet>`;
        const sheetName = report.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
        const files = {
            "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
            "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
            "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(sheetName)}" sheetId="1" r:id="rId1"/></sheets><definedNames>${report.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlText(sheetName.replace(/'/g, "''"))}'!$A$${headerRow}:$${colName(columns.length - 1)}$${lastData}</definedName>` : ""}<definedName name="_xlnm.Print_Titles" localSheetId="0">'${xmlText(sheetName.replace(/'/g, "''"))}'!$${headerRow}:$${headerRow}</definedName></definedNames></workbook>`,
            "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
            "xl/styles.xml": stylesXml,
            "xl/worksheets/sheet1.xml": sheet
        };
        return new Blob([zip(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }
    // Column number of a cell's XML ("<c r="C12" ...") so cells in a row are written left to right.
    function cellCol(cellXml) {
        const letters = /r="([A-Z]+)\d+"/.exec(cellXml)[1];
        return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    }

    // ---------- Minimal zip writer (stored, no compression) ----------
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc32 = bytes => { let c = 0xFFFFFFFF; for (const b of bytes) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    function zip(files) {
        const encoder = new TextEncoder(), parts = [], central = [];
        const now = new Date();
        const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
        const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
        let offset = 0;
        for (const [name, content] of Object.entries(files)) {
            const nameBytes = encoder.encode(name), data = encoder.encode(content), crc = crc32(data);
            const local = new DataView(new ArrayBuffer(30));
            [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dosTime, 2], [12, dosDate, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nameBytes.length, 2], [28, 0, 2]]
                .forEach(([at, value, size]) => size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true));
            parts.push(new Uint8Array(local.buffer), nameBytes, data);
            const entry = new DataView(new ArrayBuffer(46));
            [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, dosTime, 2], [14, dosDate, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, nameBytes.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
                .forEach(([at, value, size]) => size === 4 ? entry.setUint32(at, value, true) : entry.setUint16(at, value, true));
            central.push(new Uint8Array(entry.buffer), nameBytes);
            offset += 30 + nameBytes.length + data.length;
        }
        const centralSize = central.reduce((n, part) => n + part.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, Object.keys(files).length, 2], [10, Object.keys(files).length, 2], [12, centralSize, 4], [16, offset, 4], [20, 0, 2]]
            .forEach(([at, value, size]) => size === 4 ? end.setUint32(at, value, true) : end.setUint16(at, value, true));
        return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
    }

    window.olvReportXlsx = build;
})();
