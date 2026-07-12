import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function handler(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);
    const { pageCount, printType, customerEmail, metadata, shippingTier } = data;

    // 1. Calculate the core production values
    const pageCost = printType === 'color' ? 0.85 : 0.30;
    const productionCost = pageCount * pageCost;

    // 2. Compute dynamic base postage mapping for standard vs tracking tier configurations
    // Standard Economy base is $4.00. Standard + Tracking is updated from $13.00 to $17.00 total.
    // If tracking is active, the base postage adjusts to isolate the remaining cost correctly.
    let basePostage = 4.00;
    if (shippingTier === 'tracking') {
      // Base tracking premium changes to hit the absolute target value floor precisely
      basePostage = 17.00 - productionCost; 
      if (basePostage < 0) basePostage = 17.00; // Safeguard configuration floor
    }

    // Additional sheet surcharge for excessive weights/pages
    const volumeSurcharge = pageCount > 6 ? 2.50 : 0.00;
    
    // Total calculation derived for Stripe Line Items (converted into cents)
    const unitAmountCents = Math.round((basePostage + volumeSurcharge + productionCost) * 100);

    // Create standard dynamic hosted checkout mapping parameters
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: customerEmail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `PrintPostGo Mail Fulfillment (${pageCount} Pages, ${printType.toUpperCase()})`,
              description: shippingTier === 'tracking' ? 'Includes USPS Certified Postal Tracking' : 'Standard First-Class Mail Economy Delivery',
            },
            unit_amount: unitAmountCents,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.URL}/#start-order`,
      metadata: {
        ...metadata,
        pageCount: pageCount.toString(),
        printType,
        shippingTier: shippingTier || 'standard'
      },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (error) {
    console.error('Error generating checkout engine session:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to build checkout gateway.' }),
    };
  }
}