const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail = require('@sendgrid/mail');

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    // Verify webhook signature
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return { 
      statusCode: 400, 
      body: JSON.stringify({ error: `Webhook Error: ${err.message}` })
    };
  }

  // Handle successful payment
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    
    // ✅ CRITICAL FIX: Read from metadata (where you stored it), not shipping_details
    const meta = session.metadata || {};

    // Build complete order details using the correct data source
    const orderDetails = {
      // Payment Info
      sessionId: session.id,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      
      // File & Print Details
      fileUrl: meta.file_url,
      pageCount: meta.page_count,
      printType: meta.print_type || 'bw',
      mailType: meta.mail_type || 'economy',
      paperSize: meta.paper_size || 'letter',
      
      // Sender Info (From Metadata)
      sender: {
        name: meta.sender_name || 'N/A',
        address: meta.sender_address || 'N/A', // Your form sends full address as one string
        email: meta.customer_email || session.customer_details?.email
      },
      
      // Recipient Info (From Metadata)
      recipient: {
        name: meta.recipient_name || 'N/A',
        address: meta.recipient_address || 'N/A' // Your form sends full address as one string
      },
      
      // Order Details
      orderDate: meta.order_date || new Date().toISOString(),
      totalCents: meta.total_cents
    };

    console.log('✅ PAYMENT COMPLETED - Parsed Order Details:', JSON.stringify(orderDetails, null, 2));

    // 📧 SEND EMAIL VIA SENDGRID
    try {
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #1e40af; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
            .content { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; }
            .section { margin-bottom: 25px; background: white; padding: 15px; border-radius: 5px; }
            .section h3 { margin-top: 0; color: #1e40af; border-bottom: 2px solid #1e40af; padding-bottom: 5px; }
            .info-row { margin: 8px 0; }
            .label { font-weight: bold; color: #555; }
            .file-link { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin-top: 10px; font-weight: bold;}
            .file-link:hover { background: #1d4ed8; }
            .footer { text-align: center; padding: 15px; color: #777; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>✅ New Print Order Received!</h1>
              <p>Order ID: ${orderDetails.sessionId.slice(-8)}</p>
            </div>
            
            <div class="content">
              <!-- Print Job - Priority Info -->
              <div class="section">
                <h3>🖨️ Job Assets</h3>
                <div class="info-row">
                  <a href="${orderDetails.fileUrl}" class="file-link">📥 Download Customer PDF</a>
                </div>
                <br>
                <div class="info-row"><span class="label">Print Config:</span> ${orderDetails.printType.toUpperCase()} | ${orderDetails.paperSize.toUpperCase()}</div>
                <div class="info-row"><span class="label">Mail Speed:</span> ${orderDetails.mailType.toUpperCase()}</div>
                <div class="info-row"><span class="label">Page Count:</span> ${orderDetails.pageCount}</div>
              </div>

              <!-- Sender Section -->
              <div class="section">
                <h3>📧 Sender (Return Address)</h3>
                <div class="info-row"><span class="label">Name:</span> ${orderDetails.sender.name}</div>
                <div class="info-row"><span class="label">Address:</span> ${orderDetails.sender.address}</div>
                <div class="info-row"><span class="label">Email:</span> ${orderDetails.sender.email}</div>
              </div>

              <!-- Recipient Section -->
              <div class="section">
                <h3>📬 Recipient (To Address)</h3>
                <div class="info-row"><span class="label">Name:</span> ${orderDetails.recipient.name}</div>
                <div class="info-row"><span class="label">Address:</span> ${orderDetails.recipient.address}</div>
              </div>

              <!-- Payment Section -->
              <div class="section">
                <h3>💰 Payment Info</h3>
                <div class="info-row"><span class="label">Total:</span> $${(orderDetails.amountTotal / 100).toFixed(2)} USD</div>
                <div class="info-row"><span class="label">Stripe Session:</span> ${orderDetails.sessionId}</div>
              </div>
            </div>

            <div class="footer">
              <p>Sent via PrintPostGo Automated System</p>
            </div>
          </div>
        </body>
        </html>
      `;

      // ✅ CRITICAL FIX: Use string literals for emails, or validate your env vars do not have @ symbols in the KEY name
      const adminEmail = 'support@printpostgo.com'; 
      const senderIdentity = 'maurice@printpostgo.com'; // Ensure this exact email is verified in SendGrid "Sender Authentication"

      const msg = {
        to: adminEmail, 
        from: senderIdentity,
        subject: `✅ Order #${orderDetails.sessionId.slice(-8)} - ${orderDetails.sender.name}`,
        html: emailHtml,
      };

      await sgMail.send(msg);
      console.log(`✅ Email sent successfully to ${adminEmail}`);

    } catch (emailError) {
      console.error('❌ Failed to send email:', emailError.message);
      if (emailError.response) {
        console.error('SendGrid error details:', JSON.stringify(emailError.response.body, null, 2));
      }
    }
  }

  return { 
    statusCode: 200, 
    body: JSON.stringify({ received: true }) 
  };
};