/**
 * create-checkout-session.js
 * ──────────────────────────────────────────────────────────────────────────
 * Creates a Stripe Checkout session with all order data embedded in metadata.
 * The stripe-webhook.js function reads this metadata to fulfill the order.
 *
 * Pricing (must match frontend display in index.html):
 *   B&W printing:         $0.30 / page
 *   Color printing:       $0.85 / page
 *   USPS First Class:     $4.00 flat (covers up to 6 total printed pages)
 *   Overweight surcharge: $2.50 (added when total billable pages > 6)
 *   Service fee:          $1.50
 *   Large order fee:      $5.00 (when total billable pages > 100)
 *   Minimum order:        $5.00
 *
 * NOTE: Using 'insert_blank_page' adds exactly 1 page to the printed output.
 * Therefore, base printing is calculated on (uploaded pages + 1).
 * ──────────────────────────────────────────────────────────────────────────
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    if (!event.body) throw new Error('Missing request body');

    const data = JSON.parse(event.body);
    console.log('📥 Received data:', JSON.stringify(data, null, 2));

    // ── Extract & Normalize Inputs ─────────────────────────────────────────
    const {
      fileUrl,
      pageCount,
      printType    = 'bw',
      customerEmail = '',
      metadata     = {},
    } = data;

    const paperSize = 'letter'; // Standard letter size default

    // Normalize mailType: frontend sends 'standard', we treat it as 'economy'
    const rawMailType = (data.mailType || 'standard').toLowerCase();
    const mailType    = (rawMailType === 'standard' || rawMailType === 'economy')
      ? 'economy'
      : 'economy'; // Lob dev plan only supports economy/first-class — always economy

    console.log('📎 fileUrl:', fileUrl);
    console.log('📋 metadata received:', JSON.stringify(metadata, null, 2));

    if (!fileUrl) throw new Error('Missing file URL');

    const uploadedPages = Math.max(parseInt(pageCount, 10) || 1, 1);
    
    // Crucial integration: address_placement: 'insert_blank_page' adds exactly 1 page to the physical letter
    const billablePages = uploadedPages + 1; 

    // ── Pricing (all in cents) ──────────────────────────────────────────────
    const PRICE_BW           = 30;   // $0.30/page
    const PRICE_COLOR        = 85;   // $0.85/page
    const PRICE_SHIPPING     = 400;  // $4.00 flat USPS First Class (up to 6 total pages)
    const PRICE_OVERWEIGHT   = 250;  // $2.50 surcharge for letters over 6 total sheets
    const PRICE_SERVICE_FEE  = 150;  // $1.50
    const PRICE_LARGE_ORDER  = 500;  // $5.00 when > 100 pages
    const MINIMUM_ORDER      = 500;  // $5.00 minimum

    const pricePerPage   = printType === 'color' ? PRICE_COLOR : PRICE_BW;
    const printTotal     = billablePages * pricePerPage;
    const overweightFee  = billablePages > 6 ? PRICE_OVERWEIGHT : 0;
    const largeOrderFee  = billablePages > 100 ? PRICE_LARGE_ORDER : 0;

    // ── Build Stripe Line Items ─────────────────────────────────────────────
    const lineItems = [];

    // Service fee
    lineItems.push({
      price_data: {
        currency:     'usd',
        product_data: { name: 'Service Fee', description: 'Order handling & processing' },
        unit_amount:  PRICE_SERVICE_FEE,
      },
      quantity: 1,
    });

    // Printing cost
    const printLabel = printType === 'color' ? 'COLOR' : 'B&W';
    const paperLabel = 'Letter (8.5×11)';
    lineItems.push({
      price_data: {
        currency:     'usd',
        product_data: {
          name:        `${printLabel} Printing — ${paperLabel}`,
          description: `${uploadedPages} page${uploadedPages !== 1 ? 's' : ''} + 1 blank address page × $${(pricePerPage / 100).toFixed(2)}/page`,
        },
        unit_amount: pricePerPage,
      },
      quantity: billablePages,
    });

    // USPS First Class Shipping
    lineItems.push({
      price_data: {
        currency:     'usd',
        product_data: {
          name:        'USPS First Class Shipping',
          description: 'USPS First Class Mail — up to 6 total pages',
        },
        unit_amount: PRICE_SHIPPING,
      },
      quantity: 1,
    });

    // Overweight Envelope Fee (added if billablePages > 6)
    if (overweightFee > 0) {
      lineItems.push({
        price_data: {
          currency:     'usd',
          product_data: {
            name:        'Over 6 Pages Surcharge',
            description: 'Flat rate envelope weight limit exceeded (+$2.50)',
          },
          unit_amount: PRICE_OVERWEIGHT,
        },
        quantity: 1,
      });
    }

    // Large order fee (> 100 pages)
    if (largeOrderFee > 0) {
      lineItems.push({
        price_data: {
          currency:     'usd',
          product_data: {
            name:        'Large Order Processing Fee',
            description: 'Applied to orders over 100 pages',
          },
          unit_amount: PRICE_LARGE_ORDER,
        },
        quantity: 1,
      });
    }

    // Enforce minimum order total
    const calculatedTotal = PRICE_SERVICE_FEE + printTotal + PRICE_SHIPPING + overweightFee + largeOrderFee;
    const finalTotal      = Math.max(calculatedTotal, MINIMUM_ORDER);

    if (finalTotal > calculatedTotal) {
      lineItems.push({
        price_data: {
          currency:     'usd',
          product_data: {
            name:        'Minimum Order Adjustment',
            description: 'Minimum order total: $5.00',
          },
          unit_amount: finalTotal - calculatedTotal,
        },
        quantity: 1,
      });
    }

    // ── Build Stripe Metadata ───────────────────────────────────────────────
    const completeMetadata = {
      file_url:            String(fileUrl).slice(0, 499),
      page_count:          String(billablePages), // Store the absolute printed sheet count (uploaded + 1)
      uploaded_page_count: String(uploadedPages), // Store raw uploaded quantity for audit logging
      print_type:          printType,
      mail_type:           mailType,
      paper_size:          paperSize,
      customer_email:      customerEmail,
      sender_name:         String(metadata.sender          || '').slice(0, 499),
      sender_address:      String(metadata.sender_address  || '').slice(0, 499),
      recipient_name:      String(metadata.recipient       || '').slice(0, 499),
      recipient_address:   String(metadata.recipient_address || '').slice(0, 499),
      total_cents:         String(finalTotal),
      order_date:          new Date().toISOString(),
    };

    console.log('📋 Stripe metadata:', JSON.stringify(completeMetadata, null, 2));

    // ── Create Stripe Checkout Session ─────────────────────────────────────
    const origin  = process.env.URL || event.headers.origin || 'https://printpostgo.com';
    const session = await stripe.checkout.sessions.create({
      mode:                 'payment',
      payment_method_types: ['card'],
      line_items:           lineItems,
      metadata:             completeMetadata,
      customer_email:       customerEmail || undefined,
      success_url:          `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:           `${origin}/cancel.html`,
    });

    console.log('✅ Checkout session created:', session.id);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url, sessionId: session.id }),
    };

  } catch (error) {
    console.error('❌ Checkout error:', error.message);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};