import Stripe from 'stripe';
import sgMail from '@sendgrid/mail';
import fetch from 'node-fetch';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'maurice@printpostgo.com';
const ADMIN_EMAIL = 'maurice@printpostgo.com'; // Or support@printpostgo.com

async function sendCustomerReceipt(session) {
  const customerEmail = session.customer_details.email;
  const msg = {
    to: customerEmail,
    from: FROM_EMAIL,
    subject: 'Receipt: Your PrintPostGo Order',
    text: `Thank you for your order! Your document is being processed and will be mailed shortly. \n\nOrder ID: ${session.id}`,
    html: `<p>Thank you for your order!</p><p>Your document is being processed and will be mailed shortly. We will notify you once it's on its way.</p>`,
  };
  await sgMail.send(msg);
}

async function sendAdminNotification(session) {
  const { fileUrl, sender, recipient, sender_address, recipient_address } = session.metadata;
  
  // 1. Fetch the PDF to create a buffer for attachment
  let attachmentBase64 = '';
  try {
    const response = await fetch(fileUrl);
    const buffer = await response.buffer();
    attachmentBase64 = buffer.toString('base64');
  } catch (err) {
    console.error("Failed to fetch PDF for attachment:", err);
  }

  // 2. Prepare Admin Email with shipping details and attachment
  const msg = {
    to: ADMIN_EMAIL,
    from: FROM_EMAIL,
    subject: `New Order Received: ${sender} to ${recipient}`,
    text: `New order details available at: ${fileUrl}\n\nShipping From: ${sender_address}\nShipping To: ${recipient_address}`,
    html: `
      <h2>New Order Notification</h2>
      <p><strong>Shipping From:</strong> ${sender_address}</p>
      <p><strong>Shipping To:</strong> ${recipient_address}</p>
      <p><a href="${fileUrl}">Download Document PDF</a></p>
    `,
    attachments: attachmentBase64 ? [{
      content: attachmentBase64,
      filename: 'document.pdf',
      type: 'application/pdf',
      disposition: 'attachment'
    }] : []
  };

  await sgMail.send(msg);
}

export async function handler(event, context) {
  const sig = event.headers['stripe-signature'];
  let session;

  try {
    const eventData = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
    
    if (eventData.type === 'checkout.session.completed') {
      session = eventData.data.object;
      
      // Perform both notification flows
      await Promise.all([
        sendCustomerReceipt(session),
        sendAdminNotification(session)
      ]);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error("Webhook Error:", err);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }
}