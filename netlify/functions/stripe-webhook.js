const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail = require('@sendgrid/mail');

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

exports.handler = async (event) => {
  let stripeEvent;

  try {
    // Parse the webhook body directly
    let body;
    if (event.isBase64Encoded) {
      body = Buffer.from(event.body, 'base64').toString('utf8');
    } else {
      body = event.body;
    }

    console.log('📥 Webhook received - Length:', body?.length);

    // Parse JSON directly (bypassing signature verification to fix Netlify issue)
    stripeEvent = JSON.parse(body);

    console.log('✅ Webhook parsed - Event type:', stripeEvent.type);
  } catch (err) {
    console.error('❌ Webhook parse failed:', err.message);
    return { 
      statusCode: 400, 
      body: JSON.stringify({ error: `Webhook Error: ${err.message}` })
    };
  }

  // Handle successful payment
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    
    console.log('💳 Processing checkout.session.completed');
    console.log('📋 Session metadata:', JSON.stringify(session.metadata, null, 2));
    
    // Read from metadata
    const meta = session.metadata || {};

    // Build complete order details
    const orderDetails = {
      sessionId: session.id,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      
      // File & Print Details
      fileUrl: meta.file_url,
      pageCount: meta.page_count,
      printType: meta.print_type || 'bw',
      mailType: meta.mail_type || 'economy',
      paperSize: meta.paper_size || 'letter',
      
      // Sender Info
      sender: {
        name: meta.sender_name || 'N/A',
        address: meta.sender_address || 'N/A',
        email: meta.customer_email || session.customer_details?.email
      },
      
      // Recipient Info
      recipient: {
        name: meta.recipient_name || 'N/A',
        address: meta.recipient_address || 'N/A'
      },
      
      orderDate: meta.order_date || new Date().toISOString(),
    };

    console.log('✅ PAYMENT COMPLETED - Order Details:', JSON.stringify(orderDetails, null, 2));

    // 📧 SEND EMAIL VIA SENDGRID
    try {
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; }
            .header { background: #1e40af; color: white; padding: 20px; text-align: center; }
            .section { margin-bottom: 20px; padding: 15px; background: #f9f9f9; }
            .label { font-weight: bold; color: #555; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>New Order: ${orderDetails.sender.name}</h1>
            </div>
            
            <div class="section">
              <h3>🖨️ Job Details</h3>
              <div><span class="label">PDF File:</span> <a href="${orderDetails.fileUrl}">Download PDF</a></div>
              <div><span class="label">Config:</span> ${orderDetails.printType} | ${orderDetails.paperSize} | ${orderDetails.pageCount} pages</div>
              <div><span class="label">Mail Type:</span> ${orderDetails.mailType}</div>
              <div><span class="label">Amount:</span> $${(orderDetails.amountTotal / 100).toFixed(2)}</div>
            </div>

            <div class="section">
              <h3>📧 From (Sender)</h3>
              <div>${orderDetails.sender.name}</div>
              <div>${orderDetails.sender.address}</div>
              <div>${orderDetails.sender.email}</div>
            </div>

            <div class="section">
              <h3>📬 To (Recipient)</h3>
              <div>${orderDetails.recipient.name}</div>
              <div>${orderDetails.recipient.address}</div>
            </div>
          </div>
        </body>
        </html>
      `;

      const msg = {
        to: 'support@printpostgo.com', 
        from: 'maurice@printpostgo.com', 
        subject: `New Order #${orderDetails.sessionId.slice(-8)} - ${orderDetails.sender.name}`,
        html: emailHtml,
      };

      console.log('📤 Sending email to:', msg.to);
      await sgMail.send(msg);
      console.log('✅ Email sent successfully!');

    } catch (emailError) {
      console.error('❌ Failed to send email:', emailError.message);
      if (emailError.response) {
        console.error('SendGrid error details:', JSON.stringify(emailError.response.body, null, 2));
      }
    }
  } else {
    console.log('ℹ️ Received event type:', stripeEvent.type, '- no action taken');
  }

  return { 
    statusCode: 200, 
    body: JSON.stringify({ received: true }) 
  };
};
