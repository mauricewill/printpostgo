/**
 * stripe-webhook.js
 * ──────────────────────────────────────────────────────────────────────────
 * Receives Stripe webhook events and orchestrates:
 *   1. Parse the checkout.session.completed event
 *   2. Submit the letter to Lob.com for automated printing & mailing
 *   3. Send a SendGrid notification email to the operator
 *
 * IMPORTANT: Stripe requires a 200 response quickly (within ~30s) or it
 * will retry. We respond 200 FIRST, then run Lob + email in the background
 * using a fire-and-forget pattern. For Netlify functions this is safe because
 * the function stays alive until the event loop is empty.
 *
 * Idempotency: Lob's Idempotency-Key header (set to the Stripe session ID)
 * prevents duplicate letters if Stripe retries the webhook.
 * ──────────────────────────────────────────────────────────────────────────
 */

const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail  = require('@sendgrid/mail');
const { sendToLob } = require('./send-to-lob');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

exports.handler = async (event) => {

  // ── 1. Parse the incoming Stripe event ──────────────────────────────────
  let stripeEvent;
  try {
    let body;
    if (event.isBase64Encoded) {
      body = Buffer.from(event.body, 'base64').toString('utf8');
    } else {
      body = event.body;
    }

    console.log('📥 Webhook received');
    stripeEvent = JSON.parse(body);
    console.log('✅ Event type:', stripeEvent.type);

  } catch (err) {
    console.error('❌ Parse failed:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: err.message }) };
  }

  // ── 2. Only process successful checkouts ────────────────────────────────
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: JSON.stringify({ received: true, skipped: true }) };
  }

  const session = stripeEvent.data.object;
  console.log('💳 Processing checkout.session.completed:', session.id);

  // ── 3. Extract order details from Stripe metadata ───────────────────────
  const meta = session.metadata || {};

  const orderDetails = {
    sessionId:     session.id,
    paymentStatus: session.payment_status,
    amountTotal:   session.amount_total,
    fileUrl:       meta.file_url,
    pageCount:     meta.page_count,
    printType:     meta.print_type    || 'bw',
    mailType:      meta.mail_type     || 'economy',
    paperSize:     meta.paper_size    || 'letter',
    sender: {
      name:    meta.sender_name    || 'N/A',
      address: meta.sender_address || 'N/A',
      email:   meta.customer_email || session.customer_details?.email || '',
    },
    recipient: {
      name:    meta.recipient_name    || 'N/A',
      address: meta.recipient_address || 'N/A',
    },
    orderDate: meta.order_date || new Date().toISOString(),
  };

  console.log('✅ Order details parsed — session:', orderDetails.sessionId);

  // ── 4. Fire-and-forget: Lob + SendGrid ──────────────────────────────────
  // We don't await this block so Stripe gets a fast 200 response.
  // Both tasks run concurrently via Promise.allSettled so neither blocks the other.
  const fulfillmentPromise = (async () => {
    const results = await Promise.allSettled([
      sendToLob(orderDetails, session.id),
      Promise.resolve(null), // placeholder — email sent after we know Lob result
    ]);

    const lobResult  = results[0];
    let   lobId      = null;
    let   lobSuccess = false;
    let   lobError   = null;

    if (lobResult.status === 'fulfilled') {
      lobSuccess = true;
      lobId      = lobResult.value.lobId;
      console.log('✅ Lob letter submitted:', lobId);
    } else {
      lobError = lobResult.reason?.message || 'Unknown Lob error';
      console.error('❌ Lob submission failed:', lobError);
    }

    // ── 5. Send operator notification email ───────────────────────────────
    try {
      const isTestMode = (process.env.LOB_API_KEY || '').startsWith('test_');

      // Status badge for the email subject/header
      const statusBadge = lobSuccess
        ? `✅ AUTO-MAILED via Lob${isTestMode ? ' (TEST MODE)' : ''}`
        : `⚠️ LOB FAILED — MANUAL ACTION REQUIRED`;

      const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
    .container { max-width: 640px; margin: 0 auto; padding: 24px; }
    .header { background: #1e40af; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 20px; }
    .header p  { margin: 4px 0 0; font-size: 13px; opacity: 0.85; }
    .body { border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px; padding: 24px; }
    .status-banner { padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; font-weight: bold; font-size: 14px; }
    .status-success { background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
    .status-failure { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .status-test    { background: #fef9c3; color: #854d0e; border: 1px solid #fde68a; }
    .section { margin-bottom: 20px; padding: 16px; background: #f8fafc; border-radius: 6px; border: 1px solid #e2e8f0; }
    .section h3 { margin: 0 0 12px; font-size: 14px; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; }
    .row { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 14px; }
    .label { color: #64748b; font-weight: 600; }
    .value { color: #0f172a; text-align: right; max-width: 60%; word-break: break-all; }
    .lob-id { font-family: monospace; font-size: 13px; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; }
    a { color: #1e40af; }
    .footer { margin-top: 24px; font-size: 12px; color: #94a3b8; text-align: center; }
  </style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>📬 New PrintPostGo Order</h1>
    <p>${orderDetails.orderDate} &nbsp;·&nbsp; Session: ${orderDetails.sessionId}</p>
  </div>

  <div class="body">

    ${lobSuccess && !isTestMode ? `
      <div class="status-banner status-success">
        ✅ Letter automatically submitted to Lob — no manual action needed.
      </div>
    ` : ''}

    ${lobSuccess && isTestMode ? `
      <div class="status-banner status-test">
        🧪 TEST MODE — Letter submitted to Lob sandbox. No physical mail was sent.
        Check your <a href="https://dashboard.lob.com/letters">Lob dashboard</a> to see the test letter.
      </div>
    ` : ''}

    ${!lobSuccess ? `
      <div class="status-banner status-failure">
        ⚠️ LOB SUBMISSION FAILED — Manual fulfillment required!<br>
        <span style="font-weight: normal; font-size: 13px;">Error: ${lobError}</span>
      </div>
    ` : ''}

    ${lobId ? `
      <div class="section">
        <h3>🏷️ Lob Details</h3>
        <div class="row">
          <span class="label">Lob Letter ID</span>
          <span class="value lob-id">${lobId}</span>
        </div>
        <div class="row">
          <span class="label">Dashboard</span>
          <span class="value"><a href="https://dashboard.lob.com/letters">View in Lob ↗</a></span>
        </div>
      </div>
    ` : ''}

    <div class="section">
      <h3>🖨️ Print Job</h3>
      <div class="row"><span class="label">Pages</span><span class="value">${orderDetails.pageCount}</span></div>
      <div class="row"><span class="label">Print Type</span><span class="value">${orderDetails.printType === 'color' ? 'Full Color' : 'Black & White'}</span></div>
      <div class="row"><span class="label">Paper Size</span><span class="value">${orderDetails.paperSize === 'legal' ? 'Legal (8.5×14)' : 'Letter (8.5×11)'}</span></div>
      <div class="row"><span class="label">Mail Type</span><span class="value">USPS First Class</span></div>
      <div class="row"><span class="label">Amount Paid</span><span class="value">$${(orderDetails.amountTotal / 100).toFixed(2)}</span></div>
      <div class="row"><span class="label">PDF File</span><span class="value"><a href="${orderDetails.fileUrl}">Download PDF ↗</a></span></div>
    </div>

    <div class="section">
      <h3>📧 From (Sender)</h3>
      <div class="row"><span class="label">Name</span><span class="value">${orderDetails.sender.name}</span></div>
      <div class="row"><span class="label">Email</span><span class="value">${orderDetails.sender.email}</span></div>
      <div class="row"><span class="label">Address</span><span class="value">${orderDetails.sender.address}</span></div>
    </div>

    <div class="section">
      <h3>📬 To (Recipient)</h3>
      <div class="row"><span class="label">Name</span><span class="value">${orderDetails.recipient.name}</span></div>
      <div class="row"><span class="label">Address</span><span class="value">${orderDetails.recipient.address}</span></div>
    </div>

  </div>

  <div class="footer">PrintPostGo automated order notification &nbsp;·&nbsp; ${new Date().toUTCString()}</div>
</div>
</body>
</html>`;

      const subjectPrefix = lobSuccess
        ? (isTestMode ? '[TEST] ✅ Auto-Mailed' : '✅ Auto-Mailed')
        : '⚠️ MANUAL ACTION REQUIRED';

      const msg = {
        to:      'maurice@printpostgo.com',
        from:    'maurice@printpostgo.com',
        subject: `${subjectPrefix} — Order #${orderDetails.sessionId.slice(-8)} — ${orderDetails.sender.name}`,
        html:    emailHtml,
        trackingSettings: {
          clickTracking: { enable: false, enableText: false }
        },
      };

      await sgMail.send(msg);
      console.log('✅ Notification email sent');

    } catch (emailError) {
      console.error('❌ Email failed:', emailError.message);
      if (emailError.response) {
        console.error('SendGrid error detail:', JSON.stringify(emailError.response.body));
      }
    }
  })();

  // Allow the promise to run in the background — log unhandled rejections
  fulfillmentPromise.catch(err => console.error('❌ Fulfillment pipeline error:', err));

  // ── 6. Respond 200 to Stripe immediately ──────────────────────────────
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
};
