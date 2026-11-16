
const Stripe = require("stripe");

function send(res, status, data) {
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, { error: "Method not allowed" });
  }

  try {
    const {
      STRIPE_SECRET_KEY,
      STORE_URL,
      STORE_PRODUCTS_JSON
    } = process.env;

    if (!STRIPE_SECRET_KEY || !STORE_URL || !STORE_PRODUCTS_JSON) {
      return send(res, 503, {
        error: "Checkout is not configured yet."
      });
    }

    const storeUrl = new URL(STORE_URL);

    if (storeUrl.protocol !== "https:") {
      return send(res, 500, {
        error: "The store URL must use HTTPS."
      });
    }

    const products = JSON.parse(STORE_PRODUCTS_JSON);

    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;

    if (
      !body ||
      !Array.isArray(body.items) ||
      body.items.length === 0
    ) {
      return send(res, 400, {
        error: "Your basket is empty."
      });
    }

    if (body.items.length > 50) {
      return send(res, 400, {
        error: "Too many basket items."
      });
    }

    const lineItems = body.items.map((item) => {
      const product = products[item.sku];
      const quantity = Number(item.quantity);

      if (
        !product ||
        product.active !== true ||
        typeof product.name !== "string" ||
        !Number.isInteger(product.unitAmount) ||
        product.unitAmount < 1 ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        throw new Error("Invalid product or quantity.");
      }

      return {
        quantity,
        price_data: {
          currency: "gbp",
          unit_amount: product.unitAmount,
          product_data: {
            name: product.name
          }
        }
      };
    });

    const stripe = new Stripe(STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      billing_address_collection: "auto",
      shipping_address_collection: {
        allowed_countries: ["GB"]
      },
      success_url:
        storeUrl.origin +
        "/success.html?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:
        storeUrl.origin + "/?checkout=cancelled",
      metadata: {
        store: "Vault Collective"
      }
    });

    return send(res, 200, {
      url: session.url
    });

  } catch (error) {
    console.error("Checkout error:", error.message);

    return send(res, 500, {
      error: "Checkout could not be started. Please try again."
    });
  }
};
