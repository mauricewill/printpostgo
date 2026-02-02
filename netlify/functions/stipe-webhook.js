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
    
    // Get metadata
    const metadata = session.metadata;
    
    // Get shipping address (recipient)
    const recipient = session.shipping_details || {};
    const recipientAddress = recipient.address || {};
    
    // Get custom fields (sender info)
    const customFields = session.custom_fields || [];
    const senderName = customFields.find(f => f.key === 'sender_name')?.text?.value || '';
    const senderStreet = customFields.find(f => f.key === 'sender_street')?.text?.value || '';
    const senderCityStateZip = customFields.find(f => f.key === 'sender_city_state_zip')?.text?.value || '';
    
    // Get customer email and phone
    const customerEmail = session.customer_details?.email || metadata.customer_email;
    const customerPhone = session.customer_details?.phone || '';

    // Build complete order details
    const orderDetails = {
      // Payment Info
      sessionId: session.id,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      
      // File & Print Details
      fileUrl: metadata.file_url,
      pageCount: metadata.page_count,
      printType: metadata.print_type,
      mailType: metadata.mail_type,
      paperSize: metadata.paper_size,
      
      // Sender Info
      sender: {
        name: senderName,
        street: senderStreet,
        cityStateZip: senderCityStateZip,
        email: customerEmail,
        phone: customerPhone
      },
      
      // Recipient Info
      recipient: {
        name: recipient.name || '',
        street: recipientAddress.line1 || '',
        street2: recipientAddress.line2 || '',
        city: recipientAddress.city || '',
        state: recipientAddress.state || '',
        zip: recipientAddress.postal_code || '',
        country: recipientAddress.country || ''
      },
      
      // Order Details
      orderDate: metadata.order_date,
      totalCents: metadata.total_cents
    };

    // Log the complete order
    console.log('✅ PAYMENT COMPLETED - Full Order Details:', JSON.stringify(orderDetails, null, 2));

    // 📧 SEND EMAIL VIA SENDGRID
    try {
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #4CAF50; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
            .content { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; }
            .section { margin-bottom: 25px; background: white; padding: 15px; border-radius: 5px; }
            .section h3 { margin-top: 0; color: #4CAF50; border-bottom: 2px solid #4CAF50; padding-bottom: 5px; }
            .info-row { margin: 8px 0; }
            .label { font-weight: bold; color: #555; }
            .file-link { display: inline-block; background: #2196F3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 10px; }
            .file-link:hover { background: #0b7dda; }
            .footer { text-align: center; padding: 15px; color: #777; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>✅ New Print Order Received!</h1>
              <p>Order ID: ${orderDetails.sessionId}</p>
            </div>
            
            <div class="content">
              <!-- Sender Section -->
              <div class="section">
                <h3>📧 Sender Information</h3>
                <div class="info-row"><span class="label">Name:</span> ${orderDetails.sender.name}</div>
                <div class="info-row"><span class="label">Address:</span> ${orderDetails.sender.street}</div>
                <div class="info-row"><span class="label">City/State/ZIP:</span> ${orderDetails.sender.cityStateZip}</div>
                <div class="info-row"><span class="label">Email:</span> ${orderDetails.sender.email}</div>
                ${orderDetails.sender.phone ? `<div class="info-row"><span class="label">Phone:</span> ${orderDetails.sender.phone}</div>` : ''}
              </div>

              <!-- Recipient Section -->
              <div class="section">
                <h3>📬 Recipient Information</h3>
                <div class="info-row"><span class="label">Name:</span> ${orderDetails.recipient.name}</div>
                <div class="info-row"><span class="label">Address:</span> ${orderDetails.recipient.street}${orderDetails.recipient.street2 ? ' ' + orderDetails.recipient.street2 : ''}</div>
                <div class="info-row"><span class="label">City:</span> ${orderDetails.recipient.city}</div>
                <div class="info-row"><span class="label">State:</span> ${orderDetails.recipient.state}</div>
                <div class="info-row"><span class="label">ZIP:</span> ${orderDetails.recipient.zip}</div>
                <div class="info-row"><span class="label">Country:</span> ${orderDetails.recipient.country}</div>
              </div>

              <!-- Print Details Section -->
              <div class="section">
                <h3>🖨️ Print Job Details</h3>
                <div class="info-row"><span class="label">Pages:</span> ${orderDetails.pageCount}</div>
                <div class="info-row"><span class="label">Print Type:</span> ${orderDetails.printType.toUpperCase()}</div>
                <div class="info-row"><span class="label">Mail Type:</span> ${orderDetails.mailType.toUpperCase()}</div>
                <div class="info-row"><span class="label">Paper Size:</span> ${orderDetails.paperSize.toUpperCase()}</div>
                <div class="info-row">
                  <span class="label">PDF File:</span><br>
                  <a href="${orderDetails.fileUrl}" class="file-link">📥 Download PDF File</a>
                </div>
              </div>

              <!-- Payment Section -->
              <div class="section">
                <h3>💰 Payment Information</h3>
                <div class="info-row"><span class="label">Amount Paid:</span> $${(orderDetails.amountTotal / 100).toFixed(2)} USD</div>
                <div class="info-row"><span class="label">Payment Status:</span> ${orderDetails.paymentStatus}</div>
                <div class="info-row"><span class="label">Session ID:</span> ${orderDetails.sessionId}</div>
                <div class="info-row"><span class="label">Order Date:</span> ${new Date(orderDetails.orderDate).toLocaleString()}</div>
              </div>
            </div>

            <div class="footer">
              <p>This is an automated notification from your Print-to-Mail service.</p>
              <p>Login to <a href="https://dashboard.stripe.com">Stripe Dashboard</a> to view full payment details.</p>
            </div>
          </div>
        </body>
        </html>
      `;

      const msg = {
        to: process.env.support@printpostgo.com, // 
        from: process.env.maurice@printpostgo.com, // Must be verified in SendGrid
        subject: `✅ New Print Order #${orderDetails.sessionId.slice(-8)} - $${(orderDetails.amountTotal / 100).toFixed(2)}`,
        html: emailHtml,
        text: `
New Print Order Received!
========================

SENDER:
${orderDetails.sender.name}
${orderDetails.sender.street}
${orderDetails.sender.cityStateZip}
${orderDetails.sender.email}
${orderDetails.sender.phone}

RECIPIENT:
${orderDetails.recipient.name}
${orderDetails.recipient.street} ${orderDetails.recipient.street2}
${orderDetails.recipient.city}, ${orderDetails.recipient.state} ${orderDetails.recipient.zip}
${orderDetails.recipient.country}

PRINT DETAILS:
Pages: ${orderDetails.pageCount}
Type: ${orderDetails.printType}
Mail: ${orderDetails.mailType}
Paper: ${orderDetails.paperSize}
File: ${orderDetails.fileUrl}

PAYMENT:
Amount: $${(orderDetails.amountTotal / 100).toFixed(2)}
Status: ${orderDetails.paymentStatus}
Session: ${orderDetails.sessionId}
Date: ${new Date(orderDetails.orderDate).toLocaleString()}
        `
      };

      await sgMail.send(msg);
      console.log('✅ Email sent successfully to:', process.env.support@printpostgo.com);

    } catch (emailError) {
      console.error('❌ Failed to send email:', emailError.message);
      if (emailError.response) {
        console.error('SendGrid error details:', emailError.response.body);
      }
      // Don't fail the webhook if email fails - payment still succeeded
    }
  }

  return { 
    statusCode: 200, 
    body: JSON.stringify({ received: true }) 
  };
}; 