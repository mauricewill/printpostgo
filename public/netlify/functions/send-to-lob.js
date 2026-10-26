import { PDFDocument } from 'pdf-lib';
import FormData from 'form-data';
import fetch from 'node-fetch';

/**
 * Robustly parses a single string address into structured fields for the Lob API
 * Expected format examples: 
 * "123 Main St, Austin, TX 78701" OR "123 Main St Suite B, Austin, TX, 78701"
 */
function parseAddressString(addressStr) {
  const fallback = { line1: addressStr || 'N/A', city: 'N/A', state: 'XX', zip: '00000' };
  if (!addressStr || addressStr === 'N/A') return fallback;

  try {
    // Split by commas and clean up whitespace
    const parts = addressStr.split(',').map(p => p.trim()).filter(Boolean);
    
    if (parts.length >= 3) {
      // Last part usually contains State and ZIP (e.g., "TX 78701")
      const stateZipPart = parts[parts.length - 1];
      const stateZipMatch = stateZipPart.match(/^([A-Z]{2})\s+(\d{5}(-\d{4})?)$/i);
      
      let state = 'XX';
      let zip = '00000';
      
      if (stateZipMatch) {
        state = stateZipMatch[1].toUpperCase();
        zip = stateZipMatch[2];
      } else if (stateZipPart.length === 2) {
        // Fallback if state was separated by another comma
        state = stateZipPart.toUpperCase();
      }

      const city = parts[parts.length - 2];
      
      // Everything before city and state is the street line address
      const line1 = parts.slice(0, parts.length - 2).join(', ');

      return { line1, city, state, zip };
    }
    
    return fallback;
  } catch (err) {
    console.warn('Address parsing failed, utilizing fallback properties:', err);
    return fallback;
  }
}

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

    const scale = Math.min(TARGET_WIDTH / origWidth, TARGET_HEIGHT / origHeight);
    const scaledWidth = origWidth * scale;
    const scaledHeight = origHeight * scale;

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

  // 1. Download the PDF file using standard arrayBuffer() instead of the deprecated .buffer()
  console.log(`📥 Downloading PDF file for auto-resizing: ${orderDetails.fileUrl}`);
  const fileResponse = await fetch(orderDetails.fileUrl);
  if (!fileResponse.ok) {
    throw new Error(`Failed to download PDF from URL: ${fileResponse.statusText}`);
  }
  
  const arrayBuffer = await fileResponse.arrayBuffer();
  const originalPdfBuffer = Buffer.from(arrayBuffer);

  // 2. Automatically intercept and fix dimensions 
  console.log('📐 Normalizing dimensions to 8.5 in x 11 in...');
  const letterSizePdfBuffer = await normalizePdfToLetter(originalPdfBuffer);

  // 3. Break out string addresses into Lob structured fields
  const parsedRecipient = parseAddressString(orderDetails.recipient.address);
  const parsedSender = parseAddressString(orderDetails.sender.address);

  // 4. Build Multipart payload required by Lob API
  const lobForm = new FormData();
  
  lobForm.append('description', `PrintPostGo Order — Session: ${sessionId}`);
  
  // Structured Recipient Parameters
  lobForm.append('to[name]', orderDetails.recipient.name);
  lobForm.append('to[address_line1]', parsedRecipient.line1);
  lobForm.append('to[address_city]', parsedRecipient.city);
  lobForm.append('to[address_state]', parsedRecipient.state);
  lobForm.append('to[address_zip]', parsedRecipient.zip);

  // Structured Sender Parameters
  lobForm.append('from[name]', orderDetails.sender.name);
  lobForm.append('from[address_line1]', parsedSender.line1);
  lobForm.append('from[address_city]', parsedSender.city);
  lobForm.append('from[address_state]', parsedSender.state);
  lobForm.append('from[address_zip]', parsedSender.zip);

  lobForm.append('color', orderDetails.printType === 'color' ? 'true' : 'false');
  lobForm.append('mail_type', 'usps_first_class'); 
  lobForm.append('address_placement', 'insert_blank_page');

  // Attach the freshly modified binary buffer directly as the file parameter
  lobForm.append('file', letterSizePdfBuffer, {
    filename: 'normalized_document.pdf',
    contentType: 'application/pdf',
  });

  // 5. Send payload to Lob API
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