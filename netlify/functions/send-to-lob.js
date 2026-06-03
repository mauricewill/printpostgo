/**
 * send-to-lob.js
 * ──────────────────────────────────────────────────────────────────────────
 * Submits a print-and-mail job to Lob.com via their Letters API.
 *
 * Called internally from stripe-webhook.js — NOT a public HTTP endpoint.
 *
 * Lob API docs: https://docs.lob.com/#tag/Letters
 * Auth: HTTP Basic Auth  →  username = LOB_API_KEY, password = ""
 * ──────────────────────────────────────────────────────────────────────────
 */

const https = require('https');

// ─── Address Parser ────────────────────────────────────────────────────────
/**
 * Parses a single-line address string into Lob's structured fields.
 */
function parseAddress(rawStr) {
  if (!rawStr || typeof rawStr !== 'string') {
    throw new Error(`Invalid address: received "${rawStr}"`);
  }

  const parts = rawStr.split(',').map(p => p.trim()).filter(Boolean);

  if (parts.length < 3) {
    throw new Error(
      `Address "${rawStr}" could not be parsed — expected at least 3 comma-separated parts ` +
      `(street, city, state zip). Got ${parts.length} part(s): ${JSON.stringify(parts)}`
    );
  }

  const stateZipPart = parts[parts.length - 1];
  const stateZipMatch = stateZipPart.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);

  if (!stateZipMatch) {
    throw new Error(
      `Could not parse state/zip from "${stateZipPart}" in address "${rawStr}". ` +
      `Expected format: "NY 10001"`
    );
  }

  const address_state = stateZipMatch[1].toUpperCase();
  const address_zip   = stateZipMatch[2];
  const address_city  = parts[parts.length - 2];
  const address_line1 = parts.slice(0, parts.length - 2).join(', ');

  if (!address_line1) throw new Error(`Street address missing in "${rawStr}"`);
  if (!address_city)  throw new Error(`City missing in "${rawStr}"`);

  return {
    address_line1,
    address_city,
    address_state,
    address_zip,
    address_country: 'US',
  };
}

// ─── Lob API Helper ────────────────────────────────────────────────────────
function lobRequest(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const apiKey  = process.env.LOB_API_KEY;
    if (!apiKey) {
      return reject(new Error('LOB_API_KEY environment variable is not set'));
    }

    const credentials = Buffer.from(`${apiKey}:`).toString('base64');
    const bodyStr     = JSON.stringify(bodyObj);

    const options = {
      hostname: 'api.lob.com',
      port: 443,
      path,
      method,
      headers: {
        'Authorization':  `Basic ${credentials}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(
              `Lob API error ${res.statusCode}: ${JSON.stringify(parsed?.error || parsed)}`
            ));
          }
        } catch {
          reject(new Error(`Lob API non-JSON response (${res.statusCode}): ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Main Export ───────────────────────────────────────────────────────────
/**
 * sendToLob(orderDetails, idempotencyKey)
 */
async function sendToLob(orderDetails, idempotencyKey) {
  const {
    fileUrl,
    printType,   
    sender,      
    recipient,   
  } = orderDetails;

  if (!fileUrl) {
    throw new Error('No file URL provided — cannot submit to Lob without a PDF');
  }

  const fromAddress = parseAddress(sender.address);
  const toAddress   = parseAddress(recipient.address);

  // ── Build Lob letter payload ──────────────────────────────────────────
  const lobPayload = {
    description: `PrintPostGo Order — ${idempotencyKey}`,
    to: {
      name:             recipient.name || 'Recipient',
      address_line1:    toAddress.address_line1,
      address_city:     toAddress.address_city,
      address_state:    toAddress.address_state,
      address_zip:      toAddress.address_zip,
      address_country:  toAddress.address_country,
    },
    from: {
      name:             sender.name || 'Sender',
      address_line1:    fromAddress.address_line1,
      address_city:     fromAddress.address_city,
      address_state:    fromAddress.address_state,
      address_zip:      fromAddress.address_zip,
      address_country:  fromAddress.address_country,
    },
    file: fileUrl,

    color: printType === 'color',

    mail_type: 'usps_first_class',

    double_sided: false,

    // Insert a blank address page automatically at the beginning of the file.
    // Lob handles standard window envelope positioning completely reliably with this.
    address_placement: 'insert_blank_page',

    metadata: {
      stripe_session_id: idempotencyKey,
      source:            'printpostgo',
    },
  };

  console.log('📮 Submitting letter to Lob (blank page insertion configured):', JSON.stringify({
    to:                lobPayload.to,
    from:              lobPayload.from,
    color:             lobPayload.color,
    address_placement: lobPayload.address_placement,
    idempKey:          idempotencyKey,
  }, null, 2));

  const apiKey      = process.env.LOB_API_KEY;
  const credentials = Buffer.from(`${apiKey}:`).toString('base64');
  const bodyStr     = JSON.stringify(lobPayload);

  const result = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.lob.com',
      port: 443,
      path: '/v1/letters',
      method: 'POST',
      headers: {
        'Authorization':   `Basic ${credentials}`,
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(bodyStr),
        'Idempotency-Key': idempotencyKey, 
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(new Error(
              `Lob API error ${res.statusCode}: ${JSON.stringify(parsed?.error || parsed)}`
            ));
          }
        } catch {
          reject(new Error(`Lob API non-JSON response (${res.statusCode}): ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });

  console.log('✅ Lob letter created:', result.id, '| Expected delivery:', result.expected_delivery_date);

  return {
    lobId:                result.id,
    expectedDeliveryDate: result.expected_delivery_date || 'N/A',
    trackingNumber:       result.tracking_number || null,
    lobUrl:               result.url || null, 
  };
}

module.exports = { sendToLob, parseAddress };