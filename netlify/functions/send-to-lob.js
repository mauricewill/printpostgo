import { PDFDocument } from 'pdf-lib';
import Busboy from 'busboy';
import FormData from 'form-data';
import fetch from 'node-fetch';

// --- PDF NORMALIZATION HELPER ---
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

// --- HELPER TO PARSE MULTIPART FORM ---
function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: event.headers });
    const result = { files: {}, fields: {} };

    busboy.on('file', (fieldname, file, info) => {
      const buffers = [];
      file.on('data', (data) => buffers.push(data));
      file.on('end', () => {
        result.files[fieldname] = {
          buffer: Buffer.concat(buffers),
          filename: info.filename,
          mimeType: info.mimeType
        };
      });
    });

    busboy.on('field', (fieldname, val) => {
      result.fields[fieldname] = val;
    });

    busboy.on('finish', () => resolve(result));
    busboy.on('error', (err) => reject(err));

    // Write the Netlify event body stream into busboy
    busboy.write(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'));
    busboy.end();
  });
}

// --- MAIN NETLIFY HANDLER ---
export async function handler(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // 1. Parse incoming user file from front-end request
    const parsedData = await parseMultipartForm(event);
    const userFile = parsedData.files.file; // Assumes your frontend input key is named 'file'

    if (!userFile) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No PDF file provided.' }) };
    }

    // 2. Automatically intercept and fix dimensions 
    console.log(`Normalizing file: ${userFile.filename}`);
    const letterSizePdfBuffer = await normalizePdfToLetter(userFile.buffer);

    // 3. Build Multipart payload required by Lob API
    const lobForm = new FormData();
    
    // Dynamically append your required address parameters sent from frontend, or hardcode them
    lobForm.append('description', parsedData.fields.description || 'PrintPostGo Mailer');
    lobForm.append('to', parsedData.fields.to_address_id || 'adr_xxxxxxxxxx'); 
    lobForm.append('from', parsedData.fields.from_address_id || 'adr_xxxxxxxxxx');
    lobForm.append('color', 'true');
    
    // Attach the freshly modified binary buffer directly as the file parameter
    lobForm.append('file', letterSizePdfBuffer, {
      filename: 'normalized_document.pdf',
      contentType: 'application/pdf',
    });

    // 4. Send payload to Lob API
    const lobResponse = await fetch('https://api.lob.com/v1/letters', {
      method: 'POST',
      headers: {
        // Basic auth using your Lob secret API key stored in Netlify environment variables
        'Authorization': `Basic ${Buffer.from(process.env.LOB_SECRET_API_KEY + ':').toString('base64')}`,
        ...lobForm.getHeaders()
      },
      body: lobForm
    });

    const lobData = await lobResponse.json();

    if (!lobResponse.ok) {
      console.error('Lob failure:', lobData);
      return {
        statusCode: lobResponse.status,
        body: JSON.stringify({ error: 'Lob processing error', details: lobData })
      };
    }

    // Success! Return Lob response payload back to your frontend UI
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, data: lobData })
    };

  } catch (error) {
    console.error('Server error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error', message: error.message })
    };
  }
}