import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function handler(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);
    const { pageCount, printType, mailType, customerEmail, fileUrl, metadata } = data;

    const lineItems = [];

    // 1. Dynamic Print Pages (Using Quantity for precise per-page itemization)
    const pageCostCents = printType === 'color' ? 85 : 30;
    const printLabel = printType === 'color' ? 'Full Color' : 'Black & White';
    
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Document Printing (${printLabel})`,
          description: `${pageCount} pages at $${(pageCostCents / 100).toFixed(2)} per page`,
        },
        unit_amount: pageCostCents,
      },
      quantity: pageCount,
    });

    // 2. Shipping & Postage Tier Selection
    const shippingRatesCents = {
      economy: 400,       // $4.00
      standard: 1700,     // $17.00
      certified: 2100     // $21.00
    };
    const shippingCostCents = shippingRatesCents[mailType] || 400;

    let shippingLabel = 'Standard First-Class Mail Economy Delivery';
    if (mailType === 'standard') {
      shippingLabel = 'USPS Priority Mail (Tracking included)';
    } else if (mailType === 'certified') {
      shippingLabel = 'USPS Certified + Electronic Return Receipt';
    }

    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `USPS Shipping: ${shippingLabel}`,
          description: 'Secure physical postage',
        },
        unit_amount: shippingCostCents,
      },
      quantity: 1,
    });

    // 3. Processing & Collation Service Fee
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Fulfillment Service Fee',
          description: 'Document stuffing, custom envelopes, and automated sorting',
        },
        unit_amount: 150, // $1.50
      },
      quantity: 1,
    });

    // 4. Overweight Surcharges (Restricted to Economy envelopes exceeding 10 sheets)
    if (pageCount > 10 && mailType === 'economy') {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Overweight Envelope Surcharge',
            description: 'Required processing premium for letters exceeding 10 pages',
          },
          unit_amount: 250, // $2.50
        },
        quantity: 1,
      });
    }

    // 5. Bulk Order Surcharges (Processing complex orders exceeding 100 sheets)
    if (pageCount > 100) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Large Order Surcharge',
            description: 'Required manual handling fee for orders exceeding 100 pages',
          },
          unit_amount: 500, // $5.00
        },
        quantity: 1,
      });
    }

    // 6. Generate Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: customerEmail,
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.URL}/#start-order`,
      metadata: {
        ...metadata,
        pageCount: pageCount.toString(),
        printType,
        mailType: mailType || 'economy',
        fileUrl: fileUrl || ''
      },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (error) {
    console.error('Error generating checkout session:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to build checkout gateway.' }),
    };
  }
}