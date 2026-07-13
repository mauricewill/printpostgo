import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export async function handler(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const data = JSON.parse(event.body);
    const { pageCount, printType, customerEmail, metadata, mailType } = data;

    // 1. Calculate the core production values (No cover page added)
    const pageCost = printType === 'color' ? 0.85 : 0.30;
    const productionCost = pageCount * pageCost;

    // 2. Compute dynamic base postage mapping
    // Changed "Standard + Tracking" option to map to Priority Mail Priority tracking descriptions
    let basePostage = 4.00;
    if (mailType === 'standard') {
      basePostage = 17.00;
    } else if (mailType === 'certified') {
      basePostage = 21.00;
    }

    // 3. Overweight sheet surcharge: only triggered on Economy tier when sheets > 10 pages
    const volumeSurcharge = (pageCount > 10 && mailType === 'economy') ? 2.50 : 0.00;

    // 4. Large order fee configuration (>100 pages)
    const largeOrderFee = pageCount > 100 ? 5.00 : 0.00;

    // 5. App processing service fee
    const serviceFee = 1.50;
    
    // Total calculation derived for Stripe Line Items (converted into cents)
    const unitAmountCents = Math.round((basePostage + volumeSurcharge + productionCost + serviceFee + largeOrderFee) * 100);

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
              description: mailType === 'economy' 
                ? 'Standard First-Class Mail Economy Delivery (No Tracking)' 
                : mailType === 'standard' 
                ? 'USPS Priority Mail (Tracking Included)' 
                : 'USPS Certified Delivery + Electronic Signature Confirmation',
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
        shippingTier: mailType
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