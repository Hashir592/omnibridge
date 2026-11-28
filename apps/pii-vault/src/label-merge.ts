import { PDFDocument } from '@cantoo/pdf-lib';

/**
 * SHP-2, FA-15: label PDFs into one, in order. Each source is read, copied and dropped before the
 * next, so only the output and one label are held at a time: 200 labels fit inside the vault's
 * 256 MB (the memory test runs this at the vault's heap limit).
 */
export async function mergeLabelPdfs(
  count: number,
  read: (index: number) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (let i = 0; i < count; i += 1) {
    const doc = await PDFDocument.load(await read(i), { updateMetadata: false });
    const pages = await out.copyPages(doc, doc.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return out.save({ updateFieldAppearances: false });
}
