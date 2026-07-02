import { PDFDocument } from 'pdf-lib';
import FormData from 'form-data';
import fetch from 'node-fetch';

/**
 * Resizes an incoming PDF buffer to standard US Letter dimensions (8.5 x 11 inches)
 */
async function normalizePdfToLetter(pdfBuffer) {
  const TARGET_WIDTH = 8.5 * 72;  // 612 pts
  const TARGET_HEIGHT = 11 * 72;  // 792 pts

  const srcDoc = await PDFDocument.load(pdfBuffer);
  const outDoc = await PDFDocument.create();
  const pages = srcDoc.getPages();

  for (let i = 0; i < pages.length; i++) {
    const origPage = pages[i];
    const { width: origWidth, height: origHeight } = origPage.getSize();

    const newPage = outDoc.addPage([TARGET_WIDTH, TARGET_HEIGHT]);
    const [embeddedPage] = await outDoc.embedPages([srcDoc.getPages()[i]]);

    // Calculate aspect ratio scaling factor
    const scale = Math.min(TARGET_WIDTH / origWidth, TARGET_HEIGHT / origHeight);
    const scaledWidth = origWidth * scale;
    const scaledHeight = origHeight * scale;

    // Center content on the new 8.5 x 11 canvas
    const xOffset = (TARGET_WIDTH - scaledWidth) / 2;
    const yOffset = (TARGET_HEIGHT - scaledHeight) / 2;

    newPage.drawPage(embeddedPage, {
      width: scaledWidth,
      height: scaledHeight,
      x: xOffset,
      y: yOffset,
    });
  }

  const pdfBytes = await outDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Main export used by stripe-webhook.js
 */
export async function sendToLob(orderDetails, sessionId) {
  if (!orderDetails.fileUrl) {
    throw new Error('Missing fileUrl in order details');
  }

  // 1. Download the PDF file into a buffer
  console.log(`📥 Downloading PDF file for auto-resizing: ${orderDetails.fileUrl}`);
  const fileResponse = await fetch(orderDetails.fileUrl);
  if (!fileResponse.ok) {
    throw new Error(`Failed to download PDF from URL: ${fileResponse.statusText}`);
  }
  const originalPdfBuffer = await fileResponse.buffer();

  // 2. Automatically intercept and fix dimensions 
  console.log('📐 Normalizing dimensions to 8.5 in x 11 in...');
  const letterSizePdfBuffer = await normalizePdfToLetter(originalPdfBuffer);

  // 3. Build Multipart payload required by Lob API
  const lobForm = new FormData();
  
  lobForm.append('description', `PrintPostGo Order — Session: ${sessionId}`);
  lobForm.append('to[name]', orderDetails.recipient.name);
  lobForm.append('to[address_line1]', orderDetails.recipient.address); // Note: Assumes single string format or adjust to object properties if broken out
  lobForm.append('from[name]', orderDetails.sender.name);
  lobForm.append('from[address_line1]', orderDetails.sender.address);
  lobForm.append('color', orderDetails.printType === 'color' ? 'true' : 'false');
  lobForm.append('mail_type', 'usps_first_class'); // Map economy mapping to Lob API property
  lobForm.append('address_placement', 'insert_blank_page');

  // Attach the freshly modified binary buffer directly as the file parameter
  lobForm.append('file', letterSizePdfBuffer, {
    filename: 'normalized_document.pdf',
    contentType: 'application/pdf',
  });

  // 4. Send payload to Lob API
  const apiKey = process.env.LOB_SECRET_API_KEY || process.env.LOB_API_KEY;
  const lobResponse = await fetch('https://api.lob.com/v1/letters', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      ...lobForm.getHeaders()
    },
    body: lobForm
  });

  const lobData = await lobResponse.json();

  if (!lobResponse.ok) {
    throw new Error(lobData.error?.message || JSON.stringify(lobData));
  }

  return {
    lobId: lobData.id,
    expectedDeliveryDate: lobData.expected_delivery_date
  };
}