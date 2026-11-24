
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

function send(res, status, data) {
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {

  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return send(res, 405, {
      error: "Method not allowed"
    });
  }

  try {

    const {
      STRIPE_SECRET_KEY,
      STORE_URL,
      SUPABASE_URL,
      SUPABASE_SECRET_KEY
    } = process.env;

    if (
      !STRIPE_SECRET_KEY ||
      !STORE_URL ||
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY
    ) {
      return send(res, 503, {
        error: "Checkout is not configured yet."
      });
    }

    if (!STRIPE_SECRET_KEY.startsWith("sk_test_")) {
      return send(res, 503, {
        error: "Live checkout is not enabled."
      });
    }

    const storeUrl = new URL(STORE_URL);

    if (storeUrl.protocol !== "https:") {
      return send(res, 500, {
        error: "Invalid store configuration."
      });
    }

    let body;

    try {
      body = typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;
    } catch {
      return send(res, 400, {
        error: "Invalid basket."
      });
    }

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

    const quantities = new Map();

    for (const item of body.items) {

      if (
        !item ||
        typeof item.sku !== "string" ||
        item.sku.length > 80 ||
        !item.sku.trim()
      ) {
        return send(res, 400, {
          error: "Invalid product."
        });
      }

      const sku = item.sku.trim();
      const quantity = Number(item.quantity);

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        return send(res, 400, {
          error: "Invalid product quantity."
        });
      }

      const total =
        (quantities.get(sku) || 0) + quantity;

      if (total > 10) {
        return send(res, 400, {
          error: "Maximum 10 units per product."
        });
      }

      quantities.set(sku, total);
    }

    const supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SECRET_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );

    const skus = Array.from(quantities.keys());

    const { data: products, error } =
      await supabase
        .from("products")
        .select(
          "id,sku,name,price_pence,stock_quantity,active"
        )
        .in("sku", skus)
        .eq("active", true);

    if (error) {
      console.error(
        "Product database error:",
        error.message
      );

      return send(res, 503, {
        error: "Products are temporarily unavailable."
      });
    }

    const productMap = new Map(
      products.map(product => [
        product.sku,
        product
      ])
    );

    const lineItems = [];

    for (const [sku, quantity] of quantities) {

      const product = productMap.get(sku);

      if (!product || product.active !== true) {
        return send(res, 409, {
          error: "A product is no longer available."
        });
      }

      if (
        !Number.isInteger(product.price_pence) ||
        product.price_pence < 1
      ) {
        return send(res, 409, {
          error: "A product has an invalid price."
        });
      }

      if (
        !Number.isInteger(product.stock_quantity) ||
        product.stock_quantity < quantity
      ) {
        return send(res, 409, {
          error:
            "Not enough stock available for " +
            product.name + "."
        });
      }

      lineItems.push({
        quantity,

        price_data: {
          currency: "gbp",

          unit_amount: product.price_pence,

          product_data: {
            name: product.name,

            metadata: {
              sku: product.sku,
              product_id: product.id
            }
          }
        }
      });
    }

    const stripe = new Stripe(
      STRIPE_SECRET_KEY
    );

    const session =
      await stripe.checkout.sessions.create({

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
          storeUrl.origin +
          "/?checkout=cancelled",

        metadata: {
          store: "Vault Collective",
          catalogue: "supabase"
        }
      });

    return send(res, 200, {
      url: session.url
    });

  } catch (error) {

    console.error(
      "Checkout error:",
      error.message
    );

    return send(res, 500, {
      error:
        "Checkout could not be started. Please try again."
    });
  }
};
