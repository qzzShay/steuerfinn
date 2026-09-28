'use strict';
/* SteuerFinn Steuerbericht (PDF) und Steuerpaket (ZIP).
   jsPDF wird erst bei Bedarf geladen und danach offline aus dem Cache genutzt. */
const Report = (() => {
  const JSPDF = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
  const AUTOTABLE = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js';

  const load = (src) => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => { s.remove(); rej(new Error('Für den PDF-Bericht wird beim ersten Mal Internet gebraucht.')); };
    document.head.append(s);
  });
  async function ensure() {
    if (!window.jspdf) await load(JSPDF);
    if (!window.jspdf.jsPDF.API.autoTable) await load(AUTOTABLE);
  }

  const money = (v) => `${dec(v)} €`;
  const INK = [14, 21, 17], MUTED = [90, 96, 89], AUS = [29, 95, 166], GEW = [163, 72, 4], LINE = [203, 191, 164];

  // ---------- PDF ----------
  async function pdf(y) {
    await ensure();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const W = 210, H = 297, M = 16;
    const prof = S.profile || {};
    const st = yearStats(y);
    const A = st.ausbildung, G = st.gewerbe;
    const ku = kleinU();
    let yPos = 0;

    const heading = (text, color = INK, sub) => {
      if (yPos > H - 50) { doc.addPage(); yPos = M + 4; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...color);
      doc.text(text, M, yPos);
      yPos += 2;
      doc.setDrawColor(...color); doc.setLineWidth(0.6); doc.line(M, yPos, W - M, yPos);
      yPos += 5;
      if (sub) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
        const lines = doc.splitTextToSize(sub, W - 2 * M);
        doc.text(lines, M, yPos);
        yPos += lines.length * 4 + 1;
      }
      doc.setTextColor(...INK);
    };
    const table = (head, body, opts = {}) => {
      doc.autoTable({
        startY: yPos, head: [head], body, margin: { left: M, right: M },
        theme: 'grid',
        styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 1.6, lineColor: LINE, lineWidth: 0.15, textColor: INK, overflow: 'linebreak' },
        headStyles: { fillColor: opts.color || [40, 46, 42], textColor: 255, fontStyle: 'bold' },
        footStyles: { fillColor: [238, 233, 220], textColor: INK, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [250, 248, 243] },
        ...opts,
      });
      yPos = doc.lastAutoTable.finalY + 8;
    };
    const R = { halign: 'right' };

    // ---- Deckblatt / Zusammenfassung ----
    doc.setFont('helvetica', 'bold'); doc.setFontSize(22); doc.setTextColor(...INK);
    doc.text(`Steuerbericht ${y}`, M, 24);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
    const who = [prof.name, prof.adresse, prof.gewerbe ? `Gewerbe: ${prof.gewerbe}` : '', `Erstellt am ${new Date().toLocaleDateString('de-DE')} mit SteuerFinn`].filter(Boolean);
    doc.text(who, M, 31);
    yPos = 31 + who.length * 4.6 + 6;

    const aTotal = A.pendel + A.reise + A.verpfl + A.ausSum + A.konto;
    const gFahrt = G.pendel + G.reise + G.verpfl;
    const gGewinn = G.einNetto - G.ausSum - gFahrt;
    table(['Übersicht', 'Betrag'], [
      ['Ausbildung: Werbungskosten gesamt (Anlage N)', money(aTotal)],
      ['   davon über dem Arbeitnehmer-Pauschbetrag (1.230 €)', money(Math.max(0, aTotal - 1230))],
      ['Gewerbe: Betriebseinnahmen' + (ku ? ' (Kleinunternehmer, brutto)' : ' (netto)'), money(G.einNetto)],
      ['Gewerbe: Betriebsausgaben inkl. Fahrtkosten' + (ku ? '' : ' (netto)'), money(G.ausSum + gFahrt)],
      [`Gewerbe: ${gGewinn >= 0 ? 'Gewinn' : 'Verlust'}`, money(gGewinn)],
    ], { columnStyles: { 1: { ...R, cellWidth: 38 } } });

    // ---- Anlage N ----
    heading('Anlage N: Werbungskosten (Ausbildung)', AUS, 'Werte zum Übertragen in ELSTER. Das Finanzamt rechnet die Entfernungspauschale selbst aus Arbeitstagen und Entfernung.');
    const pendelA = Object.values(st.perPlace).filter((x) => x.p.bereich === 'ausbildung' && x.p.mode === 'pendel');
    if (pendelA.length) {
      table(['Erste Tätigkeitsstätte (Anschrift)', 'Arbeitstage', 'Entfernung', 'Pauschale'],
        pendelA.map((x) => [`${x.p.name}${x.p.adresse ? '\n' + x.p.adresse : ''}`, String(x.tage), `${kmText(x.p.km)} km`, money(x.betrag)]),
        { color: AUS, columnStyles: { 1: R, 2: R, 3: R } });
    }
    const reiseA = Object.values(st.perPlace).filter((x) => x.p.bereich === 'ausbildung' && x.p.mode === 'reise');
    if (reiseA.length) {
      table(['Auswärtstätigkeit (z. B. Berufsschule)', 'Fahrten', 'km gesamt', 'Fahrtkosten', 'Tage > 8 Std.'],
        reiseA.map((x) => [`${x.p.name}${x.p.adresse ? '\n' + x.p.adresse : ''}`, String(x.tage), dec(x.km, 0), money(x.fahrt), String(x.verpflTage || 0)]),
        { color: AUS, columnStyles: { 1: R, 2: R, 3: R, 4: R } });
    }
    const nRows = [
      ['Wege Wohnung – erste Tätigkeitsstätte (Entfernungspauschale)', money(A.pendel)],
      ['Reisekosten: Fahrtkosten (0,30 €/km)', money(A.reise)],
      [`Verpflegungsmehraufwand (${A.verpflTage} Tage × 14 €)`, money(A.verpfl)],
      ...Object.entries(A.posten).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, money(v)]),
    ];
    if (A.konto) nRows.push(['Kontoführungsgebühren (Pauschale ohne Nachweis)', money(A.konto)]);
    table(['Posten', 'Betrag'], nRows, { color: AUS, columnStyles: { 1: { ...R, cellWidth: 38 } }, foot: [['Summe Werbungskosten', money(aTotal)]], showFoot: 'lastPage' });

    // ---- EÜR ----
    heading('Anlage EÜR: Gewerbe', GEW, ku
      ? 'Kleinunternehmer nach § 19 UStG: alle Beträge brutto, keine Umsatzsteuer.'
      : 'Regelbesteuerung: Beträge netto. Vereinnahmte Umsatzsteuer und gezahlte Vorsteuer separat.');
    const gRows = [
      ...Object.entries(G.einPosten).map(([k, v]) => [`Einnahmen: ${k}`, money(v)]),
    ];
    if (!ku) gRows.push(['Vereinnahmte Umsatzsteuer', money(G.ust)]);
    Object.entries(G.posten).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => gRows.push([`Ausgaben: ${k}`, `-${money(v)}`]));
    if (!ku) gRows.push(['Gezahlte Vorsteuer', `-${money(G.vst)}`]);
    if (G.pendel) gRows.push([`Wege Wohnung – Betriebsstätte (${G.pendelTage} Tage, Entfernungspauschale)`, `-${money(G.pendel)}`]);
    if (G.reise) gRows.push([`Fahrtkosten Geschäftsreisen mit Privat-Kfz (${dec(G.reiseKm, 0)} km × 0,30 €)`, `-${money(G.reise)}`]);
    if (G.verpfl) gRows.push([`Verpflegungsmehraufwand (${G.verpflTage} Tage × 14 €)`, `-${money(G.verpfl)}`]);
    table(['Posten', 'Betrag'], gRows.length ? gRows : [['Keine Einträge', '']], {
      color: GEW, columnStyles: { 1: { ...R, cellWidth: 38 } },
      foot: [[gGewinn >= 0 ? 'Gewinn' + (ku ? '' : ' (bei gezahlter USt-Zahllast)') : 'Verlust', money(gGewinn)]], showFoot: 'lastPage',
    });

    // ---- Hinweise ----
    const notes = [...st.warnings];
    if (notes.length) {
      heading('Hinweise zur Prüfung', [179, 38, 30]);
      table(['Beleg', 'Hinweis'], notes.map((w) => [w.ref, w.text]), { color: [179, 38, 30], columnStyles: { 0: { cellWidth: 34 } } });
    }

    // ---- Fahrtenliste ----
    const trips = [];
    for (const rec of [...S.days.values()].filter((d) => d.date.startsWith(y + '-')).sort((a, b) => a.date.localeCompare(b.date))) {
      const wd = WD[parseIso(rec.date).getDay()];
      if (rec.status) { trips.push([deDate(rec.date), wd, STATUS[rec.status], '', '', '', rec.note || '']); continue; }
      for (const c of dayCalc(rec)) {
        trips.push([deDate(rec.date), wd, c.p.name, artText(c.art), c.art === 'verpfl' ? '' : dec(c.km, 1), money(c.betrag), rec.note || '']);
      }
    }
    if (trips.length) {
      doc.addPage(); yPos = M + 4;
      heading(`Fahrtenliste ${y}`, INK, `Wohnung: ${prof.adresse || '(Anschrift unter Mehr > Persönliche Angaben eintragen)'}`);
      table(['Datum', 'Tag', 'Ort / Anlass', 'Art', 'km', 'Betrag', 'Notiz'], trips, { columnStyles: { 4: R, 5: R }, styles: { fontSize: 7.5, cellPadding: 1.2, font: 'helvetica', lineColor: LINE, lineWidth: 0.15, textColor: INK } });
    }

    // ---- Belegliste ----
    const list = entriesOfYear(y);
    if (list.length) {
      doc.addPage(); yPos = M + 4;
      heading(`Belegliste ${y}`, INK, 'Fortlaufend nummeriert. Die Nummer steht auch auf jedem Beleg im Anhang und im Dateinamen.');
      table(['Nr.', 'Datum', 'Art', 'Kategorie / Beschreibung', 'Zahlung', 'Brutto', 'Anteil', `Ansatz ${y}`],
        list.map((e) => [e.nr, deDate(e.date), `${e.type === 'ausgabe' ? 'Ausgabe' : 'Einnahme'}\n${BEREICH[e.bereich]}`, `${e.kategorie}${e.text ? '\n' + e.text : ''}${afaNeeded(e) ? `\nAfA ${e.nd || 3} Jahre` : ''}`, ZAHLUNG[e.zahlung] || '', money(e.amount), e.type === 'ausgabe' ? `${e.anteil ?? 100} %` : '', money(ansatz(e, y))]),
        { columnStyles: { 0: { cellWidth: 18 }, 5: R, 6: R, 7: R }, styles: { fontSize: 7.5, cellPadding: 1.2, font: 'helvetica', lineColor: LINE, lineWidth: 0.15, textColor: INK } });
    }

    // ---- Belege als Anhang ----
    for (const e of list) {
      if (!e.photo) continue;
      const caption = `Beleg ${e.nr} · ${deDate(e.date)} · ${e.text || e.kategorie} · ${money(e.amount)}`;
      if (!isScan(e.photo) && !e.photo.type.startsWith('image/')) {
        doc.addPage();
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(caption, M, M + 4);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
        doc.text('Original liegt als PDF-Datei im Steuerpaket (Ordner „Belege“).', M, M + 12);
        doc.setTextColor(...INK);
        continue;
      }
      const pages = isScan(e.photo) ? e.photo.pages.map((p) => ({ data: p.data, fmt: 'JPEG' })) : [{ data: e.photo.data, fmt: e.photo.type === 'image/png' ? 'PNG' : 'JPEG' }];
      for (let i = 0; i < pages.length; i++) {
        doc.addPage();
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK);
        doc.text(caption + (pages.length > 1 ? ` · Seite ${i + 1}/${pages.length}` : ''), M, M + 4);
        const bytes = new Uint8Array(pages[i].data);
        const props = doc.getImageProperties(bytes);
        const maxW = W - 2 * M, maxH = H - M - (M + 10);
        const s = Math.min(maxW / props.width, maxH / props.height);
        const iw = props.width * s, ih = props.height * s;
        doc.addImage(bytes, pages[i].fmt, (W - iw) / 2, M + 10, iw, ih, undefined, 'NONE');
      }
    }

    // ---- Fußzeilen ----
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTED);
      doc.text(`SteuerFinn · Steuerbericht ${y}${prof.name ? ' · ' + prof.name : ''}`, M, H - 8);
      doc.text(`Seite ${i} von ${n}`, W - M, H - 8, { align: 'right' });
    }
    return doc.output('blob');
  }

  // ---------- ZIP (ohne Kompression, Fotos/PDFs sind schon komprimiert) ----------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

  async function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const data = new Uint8Array(await f.arrayBuffer());
      const name = enc.encode(f.name);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      parts.push(lh.buffer, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  return { pdf, zip };
})();
