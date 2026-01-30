const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  try {
    if (!event.body) {
      throw new Error("Missing request body");
    }

    const data = JSON.parse(event.body);

    /**
     * ==============================
     * 1. SAFELY EXTRACT INPUTS
     * ==============================
     */
    const {
      fileUrl,
      pageCount,
      printType = "bw",
      mailType = "first_class",
      paperSize = "letter"
    } = data;

    if (!fileUrl) {
      throw new Error("Missing file URL");
    }

    const pages = Math.max(parseInt(pageCount, 10) || 1, 1);

    /**
     * ==============================
     * 2. PRICING RULES (CENTS)
     * ==============================
     * All pricing is enforced HERE.
     * Frontend prices are ignored.
     */

    const BASE_FEE = 150; // $1.50 handling
    const PRICE_PER_PAGE_BW = 15; // $0.15
    const PRICE_PER_PAGE_COLOR = 45; // $0.45

    const MAIL_PRICES = {
      first_class: 125, // $1.25
      priority: 850,    // $8.50
      certified: 425    // $4.25
    };

    const pricePerPage =
      printType === "color"
        ? PRICE_PER_PAGE_COLOR
        : PRICE_PER_PAGE_BW;

    const mailCost = MAIL_PRICES[mailType] ?? MAIL_PRICES.first_class;

    /**
     * ==============================
     * 3. TOTAL CALCULATION
     * ==============================
     */
    let totalAmount =
      BASE_FEE +
      pages * pricePerPage +
      mailCost;

    // Absolute minimum charge safeguard ($2.50)
    totalAmount = Math.max(totalAmount, 250);

    /**
     * ==============================
     * 4. STRIPE SESSION
     * ==============================
     */
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Print & Mail Service",
              description: `${pages} pages • ${printType.toUpperCase()} • ${mailType.replace("_", " ")}`
            },
            unit_amount: totalAmount
          },
          quantity: 1
        }
      ],

      metadata: {
        file_url: fileUrl,
        page_count: pages.toString(),
        print_type: printType,
        mail_type: mailType,
        paper_size: paperSize,
        total_cents: totalAmount.toString()
      },

      success_url: `${process.env.URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.URL}/cancel.html`
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url })
    };

  } catch (error) {
    console.error("Checkout error:", error.message);

    return {
      statusCode: 400,
      body: JSON.stringify({
        error: error.message
      })
    };
  }
};
