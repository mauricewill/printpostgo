const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    if (!event.body) {
      throw new Error("Missing request body");
    }

    const data = JSON.parse(event.body);
    console.log("📥 Received data:", JSON.stringify(data, null, 2));

    /**
     * ==============================
     * 1. EXTRACT INPUTS
     * ==============================
     */
    const {
      fileUrl,
      pageCount,
      printType = "bw",
      mailType = "economy",
      paperSize = "letter",
      customerEmail = "",
      metadata = {}
    } = data;

    // Log what we received for debugging
    console.log("📎 fileUrl:", fileUrl);
    console.log("📋 metadata received:", JSON.stringify(metadata, null, 2));

    // Validate required fields
    if (!fileUrl) {
      throw new Error("Missing file URL");
    }

    const pages = Math.max(parseInt(pageCount, 10) || 1, 1);

    /**
     * ==============================
     * 2. PRICING RULES (CENTS)
     * ==============================
     */
    const BASE_FEE = 100;
    const PRICE_PER_PAGE_BW = 30;
    const PRICE_PER_PAGE_COLOR = 85;

    const MAIL_PRICES = {
      economy: 400,
      priority: 1900
    };

    const pricePerPage = printType === "color" ? PRICE_PER_PAGE_COLOR : PRICE_PER_PAGE_BW;
    const mailCost = MAIL_PRICES[mailType] || MAIL_PRICES.economy;
    const printingTotal = pages * pricePerPage;

    /**
     * ==============================
     * 3. BUILD LINE ITEMS
     * ==============================
     */
    const lineItems = [];

    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: 'Service Fee', description: 'Handling and processing' },
        unit_amount: BASE_FEE
      },
      quantity: 1
    });

    const printTypeName = printType === "color" ? "COLOR" : "B&W";
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${printTypeName} Printing`,
          description: `${pages} page${pages > 1 ? 's' : ''} × $${(pricePerPage / 100).toFixed(2)}/page`
        },
        unit_amount: pricePerPage
      },
      quantity: pages
    });

    const mailTypeNames = { economy: 'Economy Mail', priority: 'Priority Mail' };
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: mailTypeNames[mailType] || 'Economy Mail',
          description: `${paperSize.toUpperCase()} paper`
        },
        unit_amount: mailCost
      },
      quantity: 1
    });

    const calculatedTotal = BASE_FEE + printingTotal + mailCost;
    const MINIMUM_ORDER = 500;
    const finalTotal = Math.max(calculatedTotal, MINIMUM_ORDER);

    if (finalTotal > calculatedTotal) {
      const adjustment = finalTotal - calculatedTotal;
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Minimum Order Adjustment', description: 'Minimum order total: $5.00' },
          unit_amount: adjustment
        },
        quantity: 1
      });
    }

    /**
     * ==============================
     * 4. BUILD METADATA
     * ✅ FIX: Correctly map frontend metadata keys to Stripe metadata
     * Frontend sends: metadata.sender, metadata.sender_address, metadata.recipient, metadata.recipient_address
     * ==============================
     */
    const completeMetadata = {
      file_url: fileUrl,                              // Top-level fileUrl from payload
      page_count: pages.toString(),
      print_type: printType,
      mail_type: mailType,
      paper_size: paperSize,
      customer_email: customerEmail,
      sender_name: metadata.sender || "",             // Frontend sends as "sender"
      sender_address: metadata.sender_address || "",
      recipient_name: metadata.recipient || "",        // Frontend sends as "recipient"
      recipient_address: metadata.recipient_address || "",
      total_cents: finalTotal.toString(),
      order_date: new Date().toISOString()
    };

    console.log("📋 Stripe metadata being saved:", JSON.stringify(completeMetadata, null, 2));

    /**
     * ==============================
     * 5. CREATE STRIPE SESSION
     * ==============================
     */
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      metadata: completeMetadata,
      customer_email: customerEmail || undefined,
      success_url: `${process.env.URL || event.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.URL || event.headers.origin}/cancel.html`
    });

    console.log('✅ Checkout session created:', session.id);
    console.log('✅ Metadata saved to session:', JSON.stringify(session.metadata, null, 2));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url, sessionId: session.id })
    };

  } catch (error) {
    console.error('❌ Checkout error:', error.message);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
