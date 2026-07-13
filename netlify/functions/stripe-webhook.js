import Stripe from 'stripe';

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

    // Harvesting synchronized order variables passed through from Checkout creation payload
    const { 
      pageCount, 
      printType, 
      mailType, // Aligned with updated frontend config variables (economy, standard, certified)
      sender, 
      sender_address, 
      recipient, 
      recipient_address,
      fileUrl 
    } = session.metadata;
    
    const customerEmail = session.customer_details?.email || session.customer_email;

    console.log(`Processing Order for ${customerEmail} - Type: ${mailType}, Pages: ${pageCount}, Print Style: ${printType}`);

    try {
      // Downstream dispatch for physical printing and mailing services (e.g. Lob, Docs on Demand)
      // Economy uses standard delivery, standard (Priority + Tracking) & certified use verified tracking carriers.
      const trackingEnabled = ['standard', 'certified'].includes(mailType);
      
      console.log('Sending payload downstream with metadata:', {
        sender,
        sender_address,
        recipient,
        recipient_address,
        printType,
        pageCount: parseInt(pageCount, 10),
        trackingEnabled,
        fileUrl
      });

      // Example downstream payload routing implementation:
      // await sendToMailingProvider({ sender, recipient, printType, trackingEnabled });
      
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