const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle OPTIONS request for CORS
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
     * 1. SAFELY EXTRACT INPUTS
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

    // Validate required fields
    if (!fileUrl) {
      throw new Error("Missing file URL");
    }

    // Ensure pageCount is a valid positive integer
    const pages = Math.max(parseInt(pageCount, 10) || 1, 1);
    
    if (isNaN(pages) || pages < 1) {
      throw new Error(`Invalid page count: ${pageCount}`);
    }

    console.log(`📄 Processing order: ${pages} pages, ${printType}, ${mailType}, ${paperSize}`);

    /**
     * ==============================
     * 2. PRICING RULES (CENTS)
     * ==============================
     */
    const BASE_FEE = 150; // $1.50 handling/service fee
    const PRICE_PER_PAGE_BW = 30; // $0.30
    const PRICE_PER_PAGE_COLOR = 85; // $0.85
    const LEGAL_SURCHARGE = 10; // $0.10 per page for legal size
    const LARGE_ORDER_FEE = 500; // $5.00 for orders with 10+ pages

    const MAIL_PRICES = {
      standard: 400,      // $4.00 - Economy/Standard mail
      large: 1900         // $19.00 - Priority/Large envelope
    };

    // Determine per-page price
    const pricePerPage = printType === "color" ? PRICE_PER_PAGE_COLOR : PRICE_PER_PAGE_BW;
    
    // Get mail cost (with fallback)
    const mailCost = MAIL_PRICES[mailType] || MAIL_PRICES.standard;

    // Calculate legal paper surcharge if applicable
    const legalSurcharge = paperSize === 'legal' ? LEGAL_SURCHARGE * pages : 0;

    // Calculate large order fee (10+ pages)
    const largeOrderFee = pages >= 10 ? LARGE_ORDER_FEE : 0;

    // Calculate printing total
    const printingTotal = pages * pricePerPage;

    console.log(`💰 Pricing breakdown:
      Base Fee: $${(BASE_FEE / 100).toFixed(2)}
      Per Page: $${(pricePerPage / 100).toFixed(2)} × ${pages} = $${(printingTotal / 100).toFixed(2)}
      Legal Surcharge: $${(legalSurcharge / 100).toFixed(2)}
      Large Order Fee: $${(largeOrderFee / 100).toFixed(2)}
      Mail: $${(mailCost / 100).toFixed(2)}
    `);

    // Validate all amounts are positive integers
    if (BASE_FEE <= 0 || pricePerPage <= 0 || mailCost <= 0) {
      throw new Error("Invalid pricing configuration");
    }

    /**
     * ==============================
     * 3. BUILD LINE ITEMS ARRAY
     * ==============================
     */
    const lineItems = [];

    // Line Item 1: Service Fee
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Service Fee',
          description: 'Handling and processing'
        },
        unit_amount: BASE_FEE
      },
      quantity: 1
    });

    // Line Item 2: Printing
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

    // Line Item 3: Mailing
    const mailTypeNames = {
      standard: 'Standard Mail (Economy)',
      large: 'Priority Mail (Large Envelope)'
    };
    
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: mailTypeNames[mailType] || 'Standard Mail (Economy)',
          description: `${paperSize.toUpperCase()} paper`
        },
        unit_amount: mailCost
      },
      quantity: 1
    });

    // Line Item 4: Legal Surcharge (if applicable)
    if (legalSurcharge > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Legal Paper Surcharge',
            description: `${pages} page${pages > 1 ? 's' : ''} × $0.10/page`
          },
          unit_amount: LEGAL_SURCHARGE
        },
        quantity: pages
      });
    }

    // Line Item 5: Large Order Fee (if applicable)
    if (largeOrderFee > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Large Order Fee',
            description: 'Orders with 10 or more pages'
          },
          unit_amount: largeOrderFee
        },
        quantity: 1
      });
    }

    // Calculate total
    const calculatedTotal = BASE_FEE + printingTotal + legalSurcharge + largeOrderFee + mailCost;
    const MINIMUM_ORDER = 500; // $5.00
    const finalTotal = Math.max(calculatedTotal, MINIMUM_ORDER);

    // Add minimum charge adjustment if needed
    if (finalTotal > calculatedTotal) {
      const adjustment = finalTotal - calculatedTotal;
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Minimum Order Adjustment',
            description: 'Minimum order total: $5.00'
          },
          unit_amount: adjustment
        },
        quantity: 1
      });
      console.log(`⚠️  Minimum order adjustment: $${(adjustment / 100).toFixed(2)}`);
    }

    console.log(`💵 Final total: $${(finalTotal / 100).toFixed(2)}`);
    console.log(`📦 Line items:`, JSON.stringify(lineItems, null, 2));

    /**
     * ==============================
     * 4. BUILD COMPLETE METADATA
     * ==============================
     */
    const completeMetadata = {
      file_url: fileUrl,
      page_count: pages.toString(),
      print_type: printType,
      mail_type: mailType,
      paper_size: paperSize,
      customer_email: customerEmail,
      sender_name: metadata.sender || "",
      sender_address: metadata.sender_address || "",
      recipient_name: metadata.recipient || "",
      recipient_address: metadata.recipient_address || "",
      total_cents: finalTotal.toString(),
      order_date: new Date().toISOString()
    };

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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        url: session.url,
        sessionId: session.id 
      })
    };

  } catch (error) {
    console.error('❌ Checkout error:', error.message);
    console.error('Stack:', error.stack);

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: error.message,
        details: 'Check Netlify function logs for more information'
      })
    };
  }
};
