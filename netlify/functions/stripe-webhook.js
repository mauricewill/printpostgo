import Stripe from 'stripe';
import sgMail from '@sendgrid/mail';
import { sendToLob } from './send-to-lob.js'; // Note the .js extension required for ES Modules

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export async function handler(event, context) {
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
    sessionId:          session.id,
    paymentStatus:      session.payment_status,
    amountTotal:        session.amount_total,
    fileUrl:            meta.file_url,
    pageCount:          meta.page_count,          
    uploadedPageCount:  meta.uploaded_page_count  || String(Math.max((parseInt(meta.page_count, 10) - 1), 1)), 
    printType:          meta.print_type           || 'bw',
    mailType:           'economy', 
    paperSize:          'letter',  
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

  console.log('✅ Order details parsed — session:', orderDetails.sessionId, '| Uploaded:', orderDetails.uploadedPageCount, '| Billable Sheets:', orderDetails.pageCount);

  // ── 4. Await Lob + SendGrid before returning ────────────────────────────
  let lobId      = null;
  let lobSuccess = false;
  let lobError   = null;
  let expectedDeliveryDate = null;

  // ── Step A: Call Lob ────────────────────────────────────────────────────
  try {
    console.log('📮 Calling Lob API with automatic dimensions scaling adjustments...');
    const lobResult = await sendToLob(orderDetails, session.id);
    lobSuccess = true;
    lobId      = lobResult.lobId;
    expectedDeliveryDate = lobResult.expectedDeliveryDate;
    console.log('✅ Lob letter submitted:', lobId);
    console.log('📅 Expected delivery:', expectedDeliveryDate);
  } catch (err) {
    lobError = err.message || 'Unknown Lob error';
    console.error('❌ Lob submission failed:', lobError);
  }

  // ── Step B: Send operator notification email ────────────────────────────
  try {
      const apiKeyCheck = process.env.LOB_SECRET_API_KEY || process.env.LOB_API_KEY || '';
      const isTestMode = apiKeyCheck.startsWith('test_');

      const subjectPrefix = lobSuccess
        ? (isTestMode ? '[TEST] ✅ Auto-Mailed' : '✅ Auto-Mailed')
        : '⚠️ MANUAL ACTION REQUIRED';

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
          <span class="label">Address Placement</span>
          <span class="value">insert_blank_page (Cover address sheet)</span>
        </div>
        ${expectedDeliveryDate ? `<div class="row"><span class="label">Expected Delivery</span><span class="value">${expectedDeliveryDate}</span></div>` : ''}
        <div class="row">
          <span class="label">Dashboard</span>
          <span class="value"><a href="https://dashboard.lob.com/letters">View in Lob ↗</a></span>
        </div>
      </div>
    ` : ''}

    <div class="section">
      <h3>🖨️ Print Job</h3>
      <div class="row">
        <span class="label">Billable Pages</span>
        <span class="value">${orderDetails.pageCount} total sheets (${orderDetails.uploadedPageCount} uploaded + 1 cover page) ${parseInt(orderDetails.pageCount, 10) > 6 ? '(Overweight Surcharge Applied)' : ''}</span>
      </div>
      <div class="row"><span class="label">Print Type</span><span class="value">${orderDetails.printType === 'color' ? 'Full Color' : 'Black & White'}</span></div>
      <div class="row"><span class="label">Paper Size</span><span class="value">Letter (8.5×11)</span></div>
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

  // ── 5. Return 200 to Stripe after all work is complete ──────────────────
  console.log('✅ Webhook handler complete — returning 200');
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true }),
  };
}