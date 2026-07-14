import Stripe from 'stripe';
import sgMail from '@sendgrid/mail';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const SUPPORT_EMAIL = 'support@printpostgo.com';
// Must be a sender verified in SendGrid's Single Sender Verification (or a
// verified domain), or SendGrid will reject the send with a 403.
// Verified sender per SendGrid dashboard: maurice@printpostgo.com
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'maurice@printpostgo.com';

// SendGrid rejects attachments over 30MB total request size. Firebase Storage
// PDFs are usually small, but this guards against silently failing on an
// oversized upload.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB, leaving headroom

async function sendOrderNotificationEmail(session) {
  const metadata = session.metadata || {};
  const {
    pageCount,
    printType,
    mailType,
    fileUrl,
    sender,
    sender_address,
    recipient,
    recipient_address,
  } = metadata;

  const customerEmail = session.customer_details?.email || 'unknown';
  const amountTotal = session.amount_total != null ? `$${(session.amount_total / 100).toFixed(2)}` : 'unknown';

  // Dump every metadata field as-is, so nothing is missed even if new
  // fields get added to checkout metadata later without this email being
  // updated to match. Sits alongside the human-readable summary below.
  const fullMetadataDump = Object.entries(metadata)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  const textBody = `New paid order received.

Stripe Session: ${session.id}
Customer Email: ${customerEmail}
Amount Paid: ${amountTotal}

--- Print Details ---
Pages: ${pageCount}
Print Type: ${printType}
Mail Type: ${mailType}

--- Sender ---
${sender}
${sender_address}

--- Recipient ---
${recipient}
${recipient_address}

--- Download PDF (Firebase) ---
${fileUrl || 'No file URL found in metadata'}

--- Full Order Metadata ---
${fullMetadataDump || '(none)'}
`;

  const msg = {
    to: SUPPORT_EMAIL,
    from: FROM_EMAIL,
    // Verified reply-to per SendGrid Single Sender Verification.
    replyTo: SUPPORT_EMAIL,
    subject: `New Order — ${pageCount} pages (${printType}, ${mailType}) — ${session.id}`,
    text: textBody,
  };

  // Attach the PDF itself, not just a link, per requirements. If the fetch
  // or attachment fails for any reason, we still send the email with the
  // fileUrl included in the body so the order isn't lost.
  if (fileUrl) {
    try {
      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) {
        throw new Error(`Fetching PDF failed: ${fileResponse.status} ${fileResponse.statusText}`);
      }

      const contentLength = Number(fileResponse.headers.get('content-length') || 0);
      if (contentLength && contentLength > MAX_ATTACHMENT_BYTES) {
        console.warn(`PDF for session ${session.id} is ${contentLength} bytes, exceeding the attachment size guard — skipping attachment, link included instead.`);
      } else {
        const arrayBuffer = await fileResponse.arrayBuffer();
        const base64Content = Buffer.from(arrayBuffer).toString('base64');

        msg.attachments = [
          {
            content: base64Content,
            filename: `order-${session.id}.pdf`,
            type: 'application/pdf',
            disposition: 'attachment',
          },
        ];
      }
    } catch (fetchErr) {
      console.error(`Could not fetch/attach PDF for session ${session.id}:`, fetchErr.message);
      // Fall through and send the email without the attachment — the
      // fileUrl in the body is still usable as a fallback.
    }
  }

  await sgMail.send(msg);
}

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

        try {
          await sendOrderNotificationEmail(session);
          console.log(`Order notification email sent to ${SUPPORT_EMAIL} for session ${session.id}`);
        } catch (emailErr) {
          // Log full SendGrid error detail (response body has the real reason,
          // e.g. unverified sender, bad API key, etc.) but don't let an email
          // failure make Stripe think the whole webhook failed and retry —
          // the payment itself was already handled successfully above.
          console.error(
            `Failed to send order notification email for session ${session.id}:`,
            emailErr.response?.body || emailErr.message
          );
        }

        // TODO: trigger the actual print/mail fulfillment job here too, e.g.:
        // await triggerPrintAndMailJob({ session });

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
