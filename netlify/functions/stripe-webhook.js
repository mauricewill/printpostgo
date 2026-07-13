import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// IMPORTANT: This endpoint must receive the RAW request body (not JSON.parse'd)
// for Stripe's signature verification to work. In Netlify, disable any body
// parsing for this function and make sure `event.body` is the untouched
// payload Stripe sent. If Netlify delivers it base64-encoded, decode first.
export async function handler(event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const signature = event.headers['stripe-signature'];
  if (!signature) {
    return { statusCode: 400, body: 'Missing Stripe signature header.' };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : event.body;

  let stripeEvent;
  try {
    // constructEvent verifies the payload was actually sent by Stripe and
    // hasn't been tampered with — never trust an unverified webhook body.
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;

        // Payment is confirmed at this point. This is the correct place to
        // kick off fulfillment (send the file + metadata to your print/mail
        // pipeline), NOT at checkout-session creation time, since a session
        // being created doesn't mean it was ever paid.
        const {
          pageCount,
          printType,
          mailType,
          fileUrl,
          sender,
          sender_address,
          recipient,
          recipient_address,
        } = session.metadata || {};

        console.log('Payment confirmed for session:', session.id, {
          customerEmail: session.customer_details?.email,
          amountTotal: session.amount_total,
          pageCount,
          printType,
          mailType,
          fileUrl,
          sender,
          sender_address,
          recipient,
          recipient_address,
        });

        // TODO: replace with your actual fulfillment trigger, e.g.:
        // await triggerPrintAndMailJob({ session });
        // await sendOrderConfirmationEmail({ session });

        break;
      }

      case 'checkout.session.expired': {
        const session = stripeEvent.data.object;
        console.log('Checkout session expired without payment:', session.id);
        // TODO: clean up any provisional records, delete unclaimed uploaded
        // files (e.g. the Firebase Storage object referenced in metadata.fileUrl)
        // so abandoned carts don't leave orphaned files.
        break;
      }

      default:
        // Unhandled event types are expected and fine to ignore — Stripe
        // sends many event types; only listen for the ones you act on.
        console.log(`Unhandled Stripe event type: ${stripeEvent.type}`);
    }

    // Always return 200 quickly once verified & processed, or Stripe will retry.
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (error) {
    console.error('Error processing webhook event:', error);
    // Returning 500 tells Stripe to retry delivery later.
    return { statusCode: 500, body: JSON.stringify({ error: 'Webhook handler failed.' }) };
  }
}
