import React, { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './style.css';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const LABEL_WIDTH = 4.1;
const LABEL_HEIGHT = 6;
const EXPORT_DPI = 203;

function makeInkIntegral(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const stride = width + 1;
  const sums = new Uint32Array((width + 1) * (height + 1));
  for (let y = 1; y <= height; y++) {
    let row = 0;
    for (let x = 1; x <= width; x++) {
      const at = ((y - 1) * width + x - 1) * 4;
      const lightness = (data[at] * 3 + data[at + 1] * 6 + data[at + 2]) / 10;
      if (lightness < 238) row++;
      sums[y * stride + x] = sums[(y - 1) * stride + x] + row;
    }
  }
  return (x, y, w, h) => {
    const x2 = x + w, y2 = y + h;
    return sums[y2 * stride + x2] - sums[y * stride + x2] - sums[y2 * stride + x] + sums[y * stride + x];
  };
}

// Flipkart's A4 invoice print places the shipping label in a centered top panel.
// Keep the crop anchored at the page top so the score cannot drift into the invoice.
async function findLabelCrop(page) {
  const viewport = page.getViewport({ scale: 0.6 });
  const scan = document.createElement('canvas');
  scan.width = Math.ceil(viewport.width);
  scan.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: scan.getContext('2d'), viewport }).promise;

  const pageWidth = viewport.width / 0.6;
  const pageHeight = viewport.height / 0.6;
  // Preserve PDFs that are already label-sized. On the A4 Flipkart template the
  // label panel is centered at about 4.1 in across and runs from y=.41 to y=5.28 in.
  if (pageWidth <= 5.5 * 72 && pageHeight <= 7 * 72) {
    scan.width = 1;
    scan.height = 1;
    return { x: 0, y: 0, width: pageWidth, height: pageHeight, pageWidth, pageHeight, view: page.view };
  }
  const cropH = Math.min(5 * 72, pageHeight);
  const cropW = Math.min(cropH * LABEL_WIDTH / LABEL_HEIGHT, pageWidth);
  const winW = Math.max(1, Math.min(scan.width, Math.round(cropW * 0.6)));
  const winH = Math.max(1, Math.min(scan.height, Math.round(cropH * 0.6)));
  const maxX = Math.max(0, scan.width - winW);
  const top = Math.min(Math.round(0.34 * 72 * 0.6), Math.max(0, scan.height - winH));
  const inkIn = makeInkIntegral(scan);
  let best = null;
  for (let x = 0; x <= maxX; x += 2) {
    const ink = inkIn(x, top, winW, winH);
    const centerBias = Math.abs((x + winW / 2) - scan.width / 2) * 0.015;
    const score = ink - centerBias;
    if (!best || score > best.score) best = { x, score };
  }
  const x = best ? best.x / 0.6 : Math.max(0, (pageWidth - cropW) / 2);
  const y = top / 0.6;
  scan.width = 1;
  scan.height = 1;
  return { x, y, width: cropW, height: cropH, pageWidth, pageHeight, view: page.view };
}

async function looksLikeFlipkartLabelPdf(pdf) {
  // Check a few opening pages so an unrelated PDF is rejected before we create
  // a downloadable file. Flipkart's print contains AWB and shipping fields plus
  // seller, item, or dispatch markers in the top label panel.
  for (let pageNo = 1; pageNo <= Math.min(pdf.numPages, 3); pageNo++) {
    const page = await pdf.getPage(pageNo);
    const pageTop = page.view[3];
    const topPanelStart = pageTop - 5.4 * 72;
    const content = await page.getTextContent();
    const labelText = content.items
      .filter(item => item.str?.trim() && item.transform?.[5] >= topPanelStart)
      .map(item => item.str)
      .join(' ')
      .toLowerCase();

    const hasTracking = /\bawb\b|air\s*way\s*bill|tracking\s*(?:id|no\.?|number)|shipment\s*(?:id|no\.?)/i.test(labelText);
    const markerGroups = [
      /shipping\s*\/\s*customer\s*address|shipping\s+address|ship\s+to|delivery\s+address/i,
      /flipkart|sku\s*id|sold\s+by|seller|gstin|ordered\s+through/i,
      /\bhbd\b|\bcpd\b|\bcod\b/i,
    ];
    const markerCount = markerGroups.filter(pattern => pattern.test(labelText)).length;
    if (hasTracking && markerCount >= 2) return true;
  }
  return false;
}

async function addCroppedPdfPage(sourcePdf, sourcePage, crop, output) {
  // Keep the original PDF objects; changing page boxes crops the vector content
  // without converting text, barcodes, or graphics into a bitmap.
  const [outPage] = await output.copyPages(sourcePdf, [sourcePage - 1]);
  const [xMin, yMin] = crop.view;
  const boxX = xMin + crop.x;
  const boxY = yMin + crop.pageHeight - crop.y - crop.height;
  outPage.setMediaBox(boxX, boxY, crop.width, crop.height);
  outPage.setCropBox(boxX, boxY, crop.width, crop.height);
  output.addPage(outPage);
}
function App() {
  const inputRef = useRef(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState('');

  const processFile = useCallback(async file => {
    if (!file || (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf'))) {
      setMessage('Choose a PDF file to get started.');
      return;
    }
    setBusy(true); setProgress(0); setResult(null); setMessage('Reading PDF…'); setFileName(file.name);
    try {
      const source = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      setMessage('Checking for a Flipkart shipping label…');
      if (!(await looksLikeFlipkartLabelPdf(source))) {
        setMessage('This PDF doesn’t look like a supported Flipkart label print. Please upload the Flipkart label PDF, not an invoice or unrelated document.');
        return;
      }
      const output = await PDFDocument.create();
      const editableSource = await PDFDocument.load(await file.arrayBuffer());
      for (let i = 1; i <= source.numPages; i++) {
        setMessage(`Finding label ${i} of ${source.numPages}…`);
        const page = await source.getPage(i);
        const crop = await findLabelCrop(page);
        await addCroppedPdfPage(editableSource, i, crop, output);
        setProgress(Math.round((i / source.numPages) * 100));
      }
      const bytes = await output.save();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      setResult({ url, pages: source.numPages, name: file.name.replace(/\.pdf$/i, '') || 'labels' });
      setMessage('Your cropped labels are ready.');
    } catch (error) {
      console.error(error);
      setMessage(error?.message || 'This PDF could not be processed. Please try another file.');
    } finally { setBusy(false); }
  }, []);

  const onInputChange = event => { processFile(event.target.files?.[0]); event.target.value = ''; };
  const onDrop = event => { event.preventDefault(); setIsDragOver(false); processFile(event.dataTransfer.files?.[0]); };

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-icon">L</span><span>labelflow<span className="brand-dot">.</span></span></a><div className="topbar-note"><span className="lock">⌑</span> Private processing <span className="top-separator">·</span> Files stay on your device</div></header>
    <main className="main">
      <div className="hero"><div className="pill"><span className="sparkle">✦</span> FLIPKART LABEL TOOL</div><h1>Labels cropped.<br/><span>Ready to print.</span></h1></div>
      <section className={`drop-card ${isDragOver ? 'drop-active' : ''} ${busy ? 'is-busy' : ''}`} onDragOver={event => {event.preventDefault();setIsDragOver(true)}} onDragLeave={() => setIsDragOver(false)} onDrop={onDrop}>
        {!busy && !result && <><div className="upload-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5"/></svg></div><h2>Drop your PDF here</h2><p>or choose a file from your device</p><button className="button primary" onClick={() => inputRef.current?.click()}>Choose PDF <span>↑</span></button><div className="file-note">PDF files · Multiple labels supported</div></>}
        {busy && <div className="processing"><div className="spinner"></div><h2>Working through your labels</h2><p>{message}</p><div className="progress-track"><div className="progress-fill" style={{width: `${Math.max(5, progress)}%`}} /></div><div className="progress-caption"><span>Auto-cropping pages</span><span>{progress}%</span></div></div>}
        {!busy && result && <div className="ready"><div className="ready-icon">✓</div><div className="ready-tag">ALL DONE</div><h2>Your labels are ready.</h2><p><strong>{result.pages} label{result.pages === 1 ? '' : 's'}</strong> cropped from {fileName}</p><a className="button primary download" href={result.url} download={`${result.name}-cropped-4.1x6.pdf`}>Download cropped PDF <span>↓</span></a><button className="button text-button" onClick={() => {setResult(null);setMessage('');inputRef.current?.click()}}>Crop another PDF</button></div>}
        <input ref={inputRef} className="file-input" type="file" accept="application/pdf,.pdf" onChange={onInputChange}/>
      </section>
      {message && !busy && !result && <div className="error-message" role="status">{message}</div>}
      <section className="how"><div className="how-heading"><span>MADE FOR QUICK SHIPPING</span><h2>From print file to label file.</h2></div><div className="steps"><article><div className="step-icon">01</div><div><h3>Upload your PDF</h3><p>Single page or a whole batch of labels.</p></div></article><article><div className="step-icon green">✦</div><div><h3>We find the top label</h3><p>Each page is cropped automatically.</p></div></article><article><div className="step-icon">↓</div><div><h3>Download and print</h3><p>One label per 4.1 × 6 inch PDF page.</p></div></article></div></section>
      <div className="privacy"><span>⌑</span> Your PDF is processed locally in your browser. It is never uploaded to a server.</div>
    </main>
    <footer><span>labelflow<span className="brand-dot">.</span></span><span>Created by Bhaudip Anghan</span><span>Made for a smoother shipping day</span></footer>
  </div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
