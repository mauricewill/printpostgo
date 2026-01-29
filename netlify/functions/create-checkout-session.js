const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  try {
    const data = JSON.parse(event.body);

    // Pull values sent from index.html
    const {
      fileUrl,        // <-- coming from frontend
      amount,
      currency = "usd",
      description
    } = data;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency,
            product_data: {
              name: description || "Print & Mail Order",
            },
            unit_amount: amount, // amount in cents
          },
          quantity: 1,
        },
      ],

      success_url: `${process.env.URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.URL}/cancel.html`,

      // 🔑 THIS IS THE IMPORTANT PART
      metadata: {
        file_url: fileUrl || "not_provided",
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url }),
    };
  } catch (error) {
    console.error("Stripe error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};