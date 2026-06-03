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
 *
 * Expected input formats (both are produced by the frontend):
 *   "123 Main St, New York, NY 10001"
 *   "456 Elm Ave, Los Angeles, CA 90001"
 *
 * Returns an object with: address_line1, address_city, address_state,
 * address_zip, address_country.
 *
 * Throws a descriptive error if any required field is missing so the caller
 * can surface it clearly instead of sending a malformed request to Lob.
 */
function parseAddress(rawStr) {
  if (!rawStr || typeof rawStr !== 'string') {
    throw new Error(`Invalid address: received "${rawStr}"`);
  }

  // Split on commas and trim each part
  const parts = rawStr.split(',').map(p => p.trim()).filter(Boolean);

  if (parts.length < 3) {
    throw new Error(
      `Address "${rawStr}" could not be parsed — expected at least 3 comma-separated parts ` +
      `(street, city, state zip). Got ${parts.length} part(s): ${JSON.stringify(parts)}`
    );
  }

  // Last segment is "STATE ZIP" e.g. "NY 10001"
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
  // Everything before city is the street (handles "Apt 4B, 123 Main St, ..." edge cases)
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
/**
 * Makes an HTTPS request to the Lob API.
 * Uses Node's built-in `https` module to keep the bundle lean.
 */
function lobRequest(path, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const apiKey  = process.env.LOB_API_KEY;
    if (!apiKey) {
      return reject(new Error('LOB_API_KEY environment variable is not set'));
    }

    // Lob uses HTTP Basic Auth: API key as username, empty string as password
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
 *
 * @param {object} orderDetails - The parsed order from the Stripe webhook
 * @param {string} idempotencyKey - Stripe session ID used to prevent duplicate letters
 *
 * @returns {Promise<{ lobId: string, expectedDeliveryDate: string }>}
 *
 * Throws on failure — caller should catch and handle gracefully.
 */
async function sendToLob(orderDetails, idempotencyKey) {
  const {
    fileUrl,
    printType,   // 'bw' | 'color'
    sender,      // { name, address, email }
    recipient,   // { name, address }
  } = orderDetails;

  // ── Validate PDF URL ──────────────────────────────────────────────────
  if (!fileUrl) {
    throw new Error('No file URL provided — cannot submit to Lob without a PDF');
  }

  // ── Parse addresses ───────────────────────────────────────────────────
  const fromAddress = parseAddress(sender.address);
  const toAddress   = parseAddress(recipient.address);

  // ── Build Lob letter payload ──────────────────────────────────────────
  // Lob Letters API: https://docs.lob.com/#tag/Letters/operation/letter_create
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
    // Lob accepts a publicly accessible PDF URL for the `file` field
    file: fileUrl,

    // Color: Lob accepts true (full color) or false (black & white)
    color: printType === 'color',

    // Only mail_type available on Lob developer plan (USPS First Class)
    mail_type: 'usps_first_class',

    double_sided: false,

    // Idempotency key prevents duplicate letters if the webhook fires twice
    // Lob honors this as an Idempotency-Key header
    metadata: {
      stripe_session_id: idempotencyKey,
      source:            'printpostgo',
    },
  };

  console.log('📮 Submitting letter to Lob:', JSON.stringify({
    to:         lobPayload.to,
    from:       lobPayload.from,
    color:      lobPayload.color,
    mail_type:  lobPayload.mail_type,
    idempKey:   idempotencyKey,
  }, null, 2));

  // Add Idempotency-Key header by patching the lobRequest for this call
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
        'Idempotency-Key': idempotencyKey, // Prevent duplicate letters on webhook retry
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
    lobUrl:               result.url || null, // Lob dashboard URL (test mode only)
  };
}

module.exports = { sendToLob, parseAddress };