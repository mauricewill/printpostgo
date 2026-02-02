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
    
    // ✅ CRITICAL FIX: Read from metadata (where your JSON shows the data actually lives)
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
      
      // Sender Info (Matches your JSON keys)
      sender: {
        name: meta.sender_name || 'N/A',
        address: meta.sender_address || 'N/A',
        email: meta.customer_email || session.customer_details?.email
      },
      
      // Recipient Info (Matches your JSON keys)
      recipient: {
        name: meta.recipient_name || 'N/A',
        address: meta.recipient_address || 'N/A'
      },
      
      orderDate: meta.order_date || new Date().toISOString(),
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
            .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; }
            .header { background: #1e40af; color: white; padding: 20px; text-align: center; }
            .section { margin-bottom: 20px; padding: 15px; background: #f9f9f9; }
            .label { font-weight: bold; color: #555; }
            .btn { display: inline-block; background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 10px; }
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
            </div>

            <div class="section">
              <h3>📧 From</h3>
              <div>${orderDetails.sender.name}</div>
              <div>${orderDetails.sender.address}</div>
              <div>${orderDetails.sender.email}</div>
            </div>

            <div class="section">
              <h3>📬 To</h3>
              <div>${orderDetails.recipient.name}</div>
              <div>${orderDetails.recipient.address}</div>
            </div>
          </div>
        </body>
        </html>
      `;

      // Define your emails as simple strings
      // ⚠️ IMPORTANT: 'from' email must be verified in SendGrid
      const msg = {
        to: 'support@printpostgo.com', 
        from: 'maurice@printpostgo.com', 
        subject: `New Order #${orderDetails.sessionId.slice(-8)}`,
        html: emailHtml,
      };

      await sgMail.send(msg);
      console.log(`✅ Email sent successfully to support@printpostgo.com`);

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