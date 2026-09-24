import React, { useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './style.css';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const LABEL_WIDTH = 4;
const LABEL_HEIGHT = 6;
const PAGE_MARGIN_PX = 40;
const EXPORT_DPI = 203;

function makeDownloadFileName(pageCount, mode, date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const timeData = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMonth() + 1)}${pad(date.getDate())}${String(date.getFullYear()).slice(-2)}`;
  return `${mode}_labels_${pageCount}_${timeData}.pdf`;
}

const AMAZON_INVOICE_MARKERS = /tax\s+invoice|bill\s+of\s+supply|cash\s+memo|invoice\s+(?:number|date|details|value)|sold\s+by\s*:/i;
const AMAZON_LABEL_MARKERS = /shipping\s+label|ship\s+to|deliver\s+to|tracking\s*(?:id|number|no\.?|#)|shipment\s*(?:id|number|no\.?|#)|amazon\s+logistics/i;

async function findAmazonLabelPages(pdf) {
  const labelPages = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
    if (AMAZON_INVOICE_MARKERS.test(pageText)) continue;
    // The supplied Amazon label pages are image based and have no searchable
    // text; retain those graphics unchanged while dropping empty/other pages.
    const operators = await page.getOperatorList();
    const hasLabelText = AMAZON_LABEL_MARKERS.test(pageText);
    const hasPageGraphics = operators.fnArray.some(fn =>
      fn === pdfjs.OPS.paintImageXObject
      || fn === pdfjs.OPS.paintJpegXObject
      || fn === pdfjs.OPS.paintInlineImageXObject,
    );
    if (hasLabelText || hasPageGraphics) labelPages.push(pageNo);
  }
  return labelPages;
}

// Use the shipping label's AWB and address text as anchors. Ink-density scanning
// can select dense invoice content elsewhere on the page.
async function findLabelCrop(page) {
  const [viewLeft, viewBottom, viewRight, viewTop] = page.view;
  const pageWidth = viewRight - viewLeft;
  const pageHeight = viewTop - viewBottom;
  if (pageWidth <= 5.5 * 72 && pageHeight <= 7 * 72) {
    return { x: 0, y: 0, width: pageWidth, height: pageHeight, pageWidth, pageHeight, view: page.view };
  }

  const items = (await page.getTextContent()).items.filter(item => item.str?.trim() && item.transform);
  const awb = items.find(item => /\bawb\b|air\s*way\s*bill|tracking\s*(?:id|no\.?|number)/i.test(item.str));
  const address = items.find(item => /shipping\s*\/\s*customer\s*address|shipping\s+address|ship\s+to|delivery\s+address/i.test(item.str));
  if (!awb || !address) {
    throw new Error('Could not locate the shipping label AWB and address on this page. No crop was made.');
  }

  const itemCenterX = item => item.transform[4] + (item.width || 0) / 2;
  const labelCenterX = (itemCenterX(awb) + itemCenterX(address)) / 2;
  const separator = items.find(item => /not\s+for\s+resale/i.test(item.str));
  const minimumBaseline = separator
    ? separator.transform[5] - 1
    : viewTop - 5 * 72;
  const labelItems = items.filter(item => {
    const baseline = item.transform[5];
    return baseline >= minimumBaseline
      && baseline <= viewTop
      && Math.abs(itemCenterX(item) - labelCenterX) <= 2.05 * 72;
  });
  if (labelItems.length < 8) {
    throw new Error('Could not isolate the shipping label from the invoice. No crop was made.');
  }

  const leftRightPadding = 4;
  const topPadding = 3;
  const bottomPadding = 8;
  const left = Math.max(viewLeft, Math.min(...labelItems.map(item => item.transform[4])) - leftRightPadding);
  const right = Math.min(viewRight, Math.max(...labelItems.map(item => item.transform[4] + (item.width || 0))) + leftRightPadding);
  const bottom = Math.max(viewBottom, Math.min(...labelItems.map(item => item.transform[5])) - bottomPadding);
  const top = Math.min(viewTop, Math.max(...labelItems.map(item => item.transform[5] + (item.height || 0))) + topPadding);
  return {
    x: left - viewLeft,
    y: viewTop - top,
    width: right - left,
    height: top - bottom,
    pageWidth,
    pageHeight,
    view: page.view,
  };
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
  const [outPage] = await output.copyPages(sourcePdf, [sourcePage - 1]);
  const [xMin, yMin] = crop.view;
  const boxX = xMin + crop.x;
  const boxY = yMin + crop.pageHeight - crop.y - crop.height;
  const croppedLabel = await output.embedPage(outPage, {
    left: boxX,
    bottom: boxY,
    right: boxX + crop.width,
    top: boxY + crop.height,
  });
  const pageWidth = LABEL_WIDTH * 72;
  const pageHeight = LABEL_HEIGHT * 72;
  const margin = PAGE_MARGIN_PX * 72 / EXPORT_DPI;
  const page = output.addPage([pageWidth, pageHeight]);
  page.drawPage(croppedLabel, {
    x: margin,
    y: margin,
    width: pageWidth - margin * 2,
    height: pageHeight - margin * 2,
  });
}
function App() {
  const inputRef = useRef(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState('flipkart');

  const processFile = useCallback(async file => {
    if (!file || (!file.type.includes('pdf') && !file.name.toLowerCase().endsWith('.pdf'))) {
      setMessage('Choose a PDF file to get started.');
      return;
    }
    setBusy(true); setProgress(0); setResult(null); setMessage('Reading PDF…'); setFileName(file.name);
    try {
      const source = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      const output = await PDFDocument.create();
      const editableSource = await PDFDocument.load(await file.arrayBuffer());
      let outputPageCount;
      if (mode === 'amazon') {
        setMessage('Checking this PDF for Amazon shipping labels…');
        if (await looksLikeFlipkartLabelPdf(source)) {
          setMessage('This looks like a Flipkart label PDF. Switch to the Flipkart tab to crop its labels.');
          return;
        }
        setMessage('Removing invoice pages and keeping Amazon shipping labels…');
        const labelPages = await findAmazonLabelPages(source);
        if (!labelPages.length) {
          setMessage('No Amazon shipping label pages were found. Please upload an Amazon label print PDF.');
          return;
        }
        const copiedPages = await output.copyPages(editableSource, labelPages.map(pageNo => pageNo - 1));
        copiedPages.forEach(page => output.addPage(page));
        outputPageCount = labelPages.length;
        setProgress(100);
      } else {
        setMessage('Checking for a Flipkart shipping label…');
        if (!(await looksLikeFlipkartLabelPdf(source))) {
          setMessage('This PDF doesn’t look like a supported Flipkart label print. Please upload the Flipkart label PDF, not an invoice or unrelated document.');
          return;
        }
        for (let i = 1; i <= source.numPages; i++) {
          setMessage(`Finding label ${i} of ${source.numPages}…`);
          const page = await source.getPage(i);
          const crop = await findLabelCrop(page);
          await addCroppedPdfPage(editableSource, i, crop, output);
          setProgress(Math.round((i / source.numPages) * 100));
        }
        outputPageCount = source.numPages;
      }
      const bytes = await output.save();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      setResult({ url, pages: outputPageCount, downloadName: makeDownloadFileName(outputPageCount, mode) });
      setMessage(mode === 'amazon' ? 'Your Amazon labels are ready.' : 'Your cropped labels are ready.');
    } catch (error) {
      console.error(error);
      setMessage(error?.message || 'This PDF could not be processed. Please try another file.');
    } finally { setBusy(false); }
  }, [mode]);

  const onInputChange = event => { processFile(event.target.files?.[0]); event.target.value = ''; };
  const onDrop = event => { event.preventDefault(); setIsDragOver(false); processFile(event.dataTransfer.files?.[0]); };

  return <div className={`app-shell theme-${mode}`}>
    <header className="topbar"><a className="brand" href="#"><span className="brand-icon">L</span><span>labelflow<span className="brand-dot">.</span></span></a><div className="topbar-note"><span className="lock">⌑</span> Private processing <span className="top-separator">·</span> Files stay on your device</div></header>
    <main className="main">
      <div className="hero"><div className="pill"><span className="sparkle">✦</span> {mode === 'amazon' ? 'AMAZON LABEL TOOL' : 'FLIPKART LABEL TOOL'}</div><h1>{mode === 'amazon' ? <>Invoices removed.<br/><span>Labels ready.</span></> : <>Labels cropped.<br/><span>Ready to print.</span></>}</h1></div>
      {!busy && <div className="mode-picker" role="group" aria-label="Shipping platform"><button className={mode === 'flipkart' ? 'selected' : ''} onClick={() => setMode('flipkart')}>Flipkart <small>Auto-crop labels</small></button><button className={mode === 'amazon' ? 'selected' : ''} onClick={() => setMode('amazon')}>Amazon <small>Remove invoice pages</small></button></div>}
      <section className={`drop-card ${isDragOver ? 'drop-active' : ''} ${busy ? 'is-busy' : ''}`} onDragOver={event => {event.preventDefault();setIsDragOver(true)}} onDragLeave={() => setIsDragOver(false)} onDrop={onDrop}>
        {!busy && !result && <><div className="upload-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v5h14v-5"/></svg></div><h2>Drop your PDF here</h2><p>or choose a file from your device</p><button className="button primary" onClick={() => inputRef.current?.click()}>Choose PDF <span>↑</span></button><div className="file-note">PDF files · Multiple labels supported</div></>}
        {busy && <div className="processing"><div className="spinner"></div><h2>{mode === 'amazon' ? 'Keeping your Amazon labels' : 'Working through your labels'}</h2><p>{message}</p><div className="progress-track"><div className="progress-fill" style={{width: `${Math.max(5, progress)}%`}} /></div><div className="progress-caption"><span>{mode === 'amazon' ? 'Removing invoice pages' : 'Auto-cropping pages'}</span><span>{progress}%</span></div></div>}
        {!busy && result && <div className="ready"><div className="ready-icon">✓</div><div className="ready-tag">ALL DONE</div><h2>Your labels are ready.</h2><p><strong>{result.pages} label{result.pages === 1 ? '' : 's'}</strong> {mode === 'amazon' ? 'kept from' : 'cropped from'} {fileName}</p><a className="button primary download" href={result.url} download={result.downloadName}>Download {mode === 'amazon' ? 'labels' : 'cropped PDF'} <span>↓</span></a><button className="button text-button" onClick={() => {setResult(null);setMessage('');inputRef.current?.click()}}>{mode === 'amazon' ? 'Process another PDF' : 'Crop another PDF'}</button></div>}
        <input ref={inputRef} className="file-input" type="file" accept="application/pdf,.pdf" onChange={onInputChange}/>
      </section>
      {message && !busy && !result && <div className="error-message" role="status">{message}</div>}
      <section className="how"><div className="how-heading"><span>MADE FOR QUICK SHIPPING</span><h2>{mode === 'amazon' ? 'Keep labels. Drop invoice pages.' : 'From print file to label file.'}</h2></div><div className="steps"><article><div className="step-icon">01</div><div><h3>Upload your PDF</h3><p>Single page or a whole batch of labels.</p></div></article><article><div className="step-icon green">✦</div><div><h3>{mode === 'amazon' ? 'We remove invoice pages' : 'We find the top label'}</h3><p>{mode === 'amazon' ? 'Shipping label pages stay full size.' : 'Each page is cropped automatically.'}</p></div></article><article><div className="step-icon">↓</div><div><h3>Download and print</h3><p>{mode === 'amazon' ? 'Original label pages, with invoices removed.' : 'One label per 4 × 6 inch PDF page.'}</p></div></article></div></section>
      <div className="privacy"><span>⌑</span> Your PDF is processed locally in your browser. It is never uploaded to a server.</div>
    </main>
    <footer><span>labelflow<span className="brand-dot">.</span></span><span>Created by Bhaudip Anghan</span><span>Made for a smoother shipping day</span></footer>
  </div>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
