import Stripe from 'stripe';
import fetch from 'node-fetch';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

export async function handler(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
  } catch (err) {
    console.error(`Webhook validation failure: ${err.message}`);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    // Safely harvest order structures embedded during step 3 framework initialization
    const { pageCount, printType, shippingTier, sender, sender_address, recipient, recipient_address } = session.metadata;
    const customerEmail = session.customer_details?.email || session.customer_email;

    console.log(`Processing Order for ${customerEmail} - Tier: ${shippingTier}, Pages: ${pageCount}`);

    try {
      // Fire payload dispatch downstream to the physical Lob automated delivery API systems here
      // Example downstream payload routing structure:
      // await sendToMailingProvider({ sender, recipient, printType, trackingEnabled: shippingTier === 'tracking' });
      
    } catch (fulfillmentError) {
      console.error('Error processing mail pipeline connection:', fulfillmentError);
      return { statusCode: 500, body: 'Fulfillment workflow pipeline error.' };
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
}