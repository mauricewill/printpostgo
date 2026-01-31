const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const data = JSON.parse(event.body);
    
    const {
      fileUrl,
      pageCount,
      printType = "bw",
      mailType = "standard",
      paperSize = "letter",
      customerEmail = "",
      metadata = {}
    } = data;

    if (!fileUrl) {
      throw new Error("Missing file URL");
    }

    const pages = Math.max(parseInt(pageCount, 10) || 1, 1);

    // PRICING IN CENTS
    const BASE_FEE = 100; // $1.00
    const PRICE_PER_PAGE_BW = 30; // $0.30
    const PRICE_PER_PAGE_COLOR = 85; // $0.85
    
    const MAIL_PRICES = {
     
      economy: 400,
      priority: 1900
      
    };

    const pricePerPage = printType === "color" ? PRICE_PER_PAGE_COLOR : PRICE_PER_PAGE_BW;
    const mailCost = MAIL_PRICES[mailType] ?? MAIL_PRICES.standard;
    const printingTotal = pages * pricePerPage;

    // BUILD LINE ITEMS ARRAY - THIS IS THE KEY!
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

    // Line Item 2: Printing (with dynamic description)
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${printType.toUpperCase()} Printing`,
          description: `${pages} page${pages > 1 ? 's' : ''} × $${(pricePerPage / 100).toFixed(2)}/page`
        },
        unit_amount: pricePerPage
      },
      quantity: pages
    });

    // Line Item 3: Mailing
    const mailTypeNames = {
      standard: 'Standard Mail (First Class)',
      first_class: 'Standard Mail (First Class)',
      large: 'Large Envelope',
      priority: 'Priority Mail',
      certified: 'Certified Mail'
    };
    
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: mailTypeNames[mailType] || 'Standard Mail',
          description: `${paperSize.toUpperCase()} paper`
        },
        unit_amount: mailCost
      },
      quantity: 1
    });

    // Calculate total for validation
    const calculatedTotal = BASE_FEE + printingTotal + mailCost;
    const finalTotal = Math.max(calculatedTotal, 500); // $5.00 minimum

    // If we need to add minimum charge
    if (finalTotal > calculatedTotal) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Minimum Order Adjustment',
            description: 'Minimum order total: $5.00'
          },
          unit_amount: finalTotal - calculatedTotal
        },
        quantity: 1
      });
    }

    // Complete metadata
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

    // CREATE STRIPE SESSION
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems, // ← MULTIPLE LINE ITEMS!
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
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};