import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Pricing constants — kept in sync with the `window.PRICES` object in index.html.
// If you change a price on the site, update it here too.
const PRICES = {
  bw: 30,          // $0.30/page, in cents
  color: 85,        // $0.85/page, in cents
  serviceFee: 150,   // $1.50 flat fulfillment fee
  overweightFee: 250, // $2.50 surcharge, Economy only, >10 pages
  largeOrderFee: 500, // $5.00 surcharge, >100 pages
  shippingRates: {
    economy: 400,     // $4.00
    standard: 1700,   // $17.00 (Priority + Tracking)
    certified: 2100,  // $21.00 (Certified + Signature)
  },
};

export async function handler(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);
    // NOTE: field names must match what index.html's handleFormSubmit() sends:
    // { pageCount, printType, mailType, customerEmail, fileUrl, metadata }
    const { pageCount, printType, mailType, customerEmail, fileUrl, metadata } = data;

    if (!pageCount || pageCount < 1) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid page count.' }),
      };
    }

    const resolvedMailType = mailType || 'economy';
    if (!PRICES.shippingRates[resolvedMailType]) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Unknown shipping option: ${resolvedMailType}` }),
      };
    }

    const lineItems = [];

    // 1. Print pages (itemized by quantity, same as the site's per-page cost)
    const pageCostCents = printType === 'color' ? PRICES.color : PRICES.bw;
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

    // 2. Shipping tier
    const shippingCostCents = PRICES.shippingRates[resolvedMailType];
    const shippingLabels = {
      economy: 'Economy Tier (USPS First Class, no tracking)',
      standard: 'Priority + Tracking (USPS Priority Mail)',
      certified: 'Certified + Signature (USPS Certified + Electronic Return Receipt)',
    };

    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Shipping: ${shippingLabels[resolvedMailType]}`,
          description: 'Secure physical postage',
        },
        unit_amount: shippingCostCents,
      },
      quantity: 1,
    });

    // 3. Fulfillment service fee (always applied)
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'Fulfillment Service Fee',
          description: 'Document stuffing, custom envelopes, and automated sorting',
        },
        unit_amount: PRICES.serviceFee,
      },
      quantity: 1,
    });

    // 4. Overweight surcharge — Economy only, >10 pages
    if (pageCount > 10 && resolvedMailType === 'economy') {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Overweight Envelope Surcharge',
            description: 'Required processing premium for letters exceeding 10 pages (Economy tier)',
          },
          unit_amount: PRICES.overweightFee,
        },
        quantity: 1,
      });
    }

    // 5. Large order surcharge — >100 pages, regardless of shipping tier
    if (pageCount > 100) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Large Order Surcharge',
            description: 'Required manual handling fee for orders exceeding 100 pages',
          },
          unit_amount: PRICES.largeOrderFee,
        },
        quantity: 1,
      });
    }

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
        mailType: resolvedMailType,
        fileUrl: fileUrl || '',
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
