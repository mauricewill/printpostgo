const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PRICES = {
    bw: 0.30,
    color: 0.85,
    legalSurcharge: 0.10,
    standardEnv: 4.00,
    largeEnv: 19.00,
    serviceFee: 1.00
};

exports.handler = async (event) => {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const data = JSON.parse(event.body);
        
        // 1. Validate inputs (Basic validation)
        if (!data.pageCount || data.pageCount < 1) throw new Error("Invalid page count");
        
        // 2. Re-calculate Price Securely (Server-Side)
        // We do NOT trust the price sent from the frontend.
        const printRate = data.printType === 'color' ? PRICES.color : PRICES.bw;
        let printCost = data.pageCount * printRate;
        
        let legalCost = 0;
        if (data.paperSize === 'legal') {
            legalCost = data.pageCount * PRICES.legalSurcharge;
        }
        
        // Enforce Envelope Rules (Backend safeguard)
        let safeMailType = data.mailType;
        if (data.pageCount > 10) safeMailType = 'large';
        
        const shippingCost = safeMailType === 'large' ? PRICES.largeEnv : PRICES.standardEnv;
        
        // Total calculation (in cents for Stripe)
        const totalAmountDollars = printCost + legalCost + shippingCost + PRICES.serviceFee;
        const totalAmountCents = Math.round(totalAmountDollars * 100);

        // 3. Create Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `Print & Mail Service (${data.pageCount} Pages)`,
                            description: `${data.printType.toUpperCase()} print on ${data.paperSize} paper via ${safeMailType === 'large' ? 'Priority' : 'Economy'} Mail.`,
                            images: ['https://cdn-icons-png.flaticon.com/512/2983/2983790.png'], // Placeholder icon
                        },
                        unit_amount: totalAmountCents, // Stripe uses cents
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: `${event.headers.origin}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${event.headers.origin}/?canceled=true`,
            customer_email: data.customerEmail,
            metadata: {
                // Attach the data needed for fulfillment
                file_url: data.fileUrl, 
                sender_address: data.metadata.sender_address,
                recipient_address: data.metadata.recipient_address,
                paper_size: data.paperSize
            }
        });

        // 4. Return the Session URL to the frontend
        return {
            statusCode: 200,
            body: JSON.stringify({ url: session.url })
        };

    } catch (error) {
        console.error("Stripe Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};