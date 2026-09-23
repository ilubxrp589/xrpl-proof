/* Receipt PDFs, written by hand and read back. One A4 page: a picture of the
 * receipt, a few lines of real text (so the hashes can be copied), and the
 * receipt's evidence attached as a file (/EmbeddedFiles, /AF), which viewers
 * list as an attachment and the Proof page reads to check it. */
const A4 = [595.276, 841.89];
const latin = s => Uint8Array.from(s, ch => ch.charCodeAt(0) & 255);
const esc = s => s.replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7E]/g, '?');
const pdfDate = d => `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
export const EVIDENCE_NAME = 'proof-receipt.json';

/** jpeg: the picture's bytes (width × height px, A4 proportions); lines: text
 *  set small along the foot of the page; evidence: the receipt, as bytes. */
export function receiptPdf({ jpeg, width, height, lines, evidence, title }) {
  const parts = [], at = [];
  let size = 0;
  const put = x => { const b = typeof x === 'string' ? latin(x) : x; parts.push(b); size += b.length; };
  const obj = (n, dict, stream) => {
    at[n] = size;
    put(`${n} 0 obj\n${dict}\n`);
    if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
    put('endobj\n');
  };
  const [pw, ph] = A4, now = pdfDate(new Date());
  const content = latin(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q\n` +
    `BT /F1 6.2 Tf 0.13 0.106 0.19 rg 7.4 TL 1 0 0 1 34 ${8 + 7.4 * (lines.length - 1)} Tm\n` +
    lines.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`).join('\n') + '\nET\n');
  put('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  obj(1, `<< /Type /Catalog /Pages 2 0 R /Lang (en-US) /AF [7 0 R] /Names << /EmbeddedFiles << /Names [(${EVIDENCE_NAME}) 7 0 R] >> >> >>`);
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> /Font << /F1 5 0 R >> >> /Contents 6 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg);
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>');
  obj(6, `<< /Length ${content.length} >>`, content);
  obj(7, `<< /Type /Filespec /F (${EVIDENCE_NAME}) /UF (${EVIDENCE_NAME}) /AFRelationship /Source ` +
         '/Desc (The evidence for this receipt. To check it, drop this PDF on the Proof page.) /EF << /F 8 0 R /UF 8 0 R >> >>');
  obj(8, `<< /Type /EmbeddedFile /Subtype /application#2Fjson /Params << /Size ${evidence.length} /ModDate (${now}) >> /Length ${evidence.length} >>`, evidence);
  obj(9, `<< /Title (${esc(title)}) /Producer (Proof) /Creator (https://v2v.halcyon-names.io/proof/) /CreationDate (${now}) >>`);
  const xref = size, id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  put(`xref\n0 10\n0000000000 65535 f \n${at.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  put(`trailer\n<< /Size 10 /Root 1 0 R /Info 9 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The evidence inside a receipt PDF (or a bare evidence file), parsed. */
export function readEvidence(bytes) {
  const td = new TextDecoder();
  const head = td.decode(bytes.subarray(0, 8)).trimStart();
  if (head.startsWith('{')) return JSON.parse(td.decode(bytes));
  if (!head.startsWith('%PDF')) throw new Error('that is not a receipt: neither a PDF nor its evidence file');
  const s = new TextDecoder('latin1').decode(bytes);          // one character per byte, so offsets line up
  const i = s.indexOf('/Type /EmbeddedFile');
  if (i < 0) throw new Error('this PDF carries no evidence, so it was not made by the Proof page');
  const len = /\/Length (\d+)/.exec(s.slice(i, i + 600));
  const st = s.indexOf('stream', i), start = st + (s[st + 6] === '\r' ? 8 : 7);
  if (!len || st < 0) throw new Error('this PDF’s evidence is damaged');
  return JSON.parse(td.decode(bytes.subarray(start, start + Number(len[1]))));
}
