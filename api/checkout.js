
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  let stripe;
  let supabase;
  let reservationId = null;
  let session = null;
  let creationAttempted = false;

  try {
    const {
      STRIPE_SECRET_KEY,
      SUPABASE_URL,
      SUPABASE_SECRET_KEY,
      STORE_URL
    } = process.env;

    if (
      !STRIPE_SECRET_KEY ||
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY ||
      !STORE_URL
    ) {
      throw new Error("Incomplete server configuration");
    }

    if (!STRIPE_SECRET_KEY.startsWith("sk_test_")) {
      throw new Error("Only Stripe test mode is enabled");
    }

    const storeUrl = new URL(STORE_URL);

    if (storeUrl.protocol !== "https:") {
      throw new Error("Invalid store URL");
    }

    stripe = new Stripe(STRIPE_SECRET_KEY);

    supabase = createClient(
      SUPABASE_URL,
      SUPABASE_SECRET_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;

    const items = body?.items;

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > 50
    ) {
      return res.status(400).json({
        error: "Invalid basket"
      });
    }

    const basket = new Map();

    for (const item of items) {
      const sku =
        typeof item?.sku === "string"
          ? item.sku.trim()
          : "";

      const quantity = item?.quantity;

      if (
        !sku ||
        sku.length > 80 ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      ) {
        return res.status(400).json({
          error: "Invalid basket item"
        });
      }

      const total =
        (basket.get(sku) || 0) + quantity;

      if (total > 10) {
        return res.status(400).json({
          error: "Maximum 10 units per product"
        });
      }

      basket.set(sku, total);
    }

    const requestedItems =
      Array.from(basket, ([sku, quantity]) => ({
        sku,
        quantity
      }));

    const skus = requestedItems.map(
      item => item.sku
    );

    const { data: products, error: productError } =
      await supabase
        .from("products")
        .select(
          "id,sku,name,price_pence,stock_quantity,active"
        )
        .in("sku", skus)
        .eq("active", true);

    if (productError) throw productError;

    const productMap = new Map(
      products.map(product => [
        product.sku,
        product
      ])
    );

    const lineItems = [];

    for (const item of requestedItems) {
      const product = productMap.get(item.sku);

      if (
        !product ||
        !Number.isInteger(product.price_pence) ||
        product.price_pence <= 0 ||
        product.stock_quantity < item.quantity
      ) {
        return res.status(409).json({
          error: "A product is unavailable or out of stock"
        });
      }

      lineItems.push({
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
        },
        quantity: item.quantity
      });
    }

    const { data: reservedId, error: reserveError } =
      await supabase.rpc("reserve_stock", {
        p_items: requestedItems
      });

    if (reserveError) {
      if (
        /insufficient available stock|product unavailable/i
          .test(reserveError.message)
      ) {
        return res.status(409).json({
          error: "Not enough available stock"
        });
      }

      throw reserveError;
    }

    reservationId = reservedId;

    if (!reservationId) {
      throw new Error("Reservation could not be created");
    }

    const expiresAt =
      Math.floor(Date.now() / 1000) + 31 * 60;

    creationAttempted = true;

    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",

        payment_method_types: ["card"],

        line_items: lineItems,

        billing_address_collection: "auto",

        shipping_address_collection: {
          allowed_countries: ["GB"]
        },

        expires_at: expiresAt,

        success_url:
          storeUrl.origin +
          "/success.html?session_id={CHECKOUT_SESSION_ID}",

        cancel_url:
          storeUrl.origin +
          "/?checkout=cancelled",

        metadata: {
          store: "Vault Collective",
          catalogue: "supabase",
          reservation_id: reservationId
        }
      },
      {
        idempotencyKey:
          "reservation-" + reservationId
      }
    );

    const { data: linked, error: linkError } =
      await supabase
        .from("stock_reservations")
        .update({
          stripe_session_id: session.id,
          status: "reserved",
          expires_at: new Date(
            session.expires_at * 1000
          ).toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", reservationId)
        .eq("status", "pending")
        .select("id")
        .single();

    if (linkError || !linked) {
      throw new Error("Reservation linking failed");
    }

    return res.status(200).json({
      url: session.url
    });

  } catch (error) {
    console.error("Checkout error:", error.message);

    let safeToRelease = !creationAttempted;

    if (session && stripe) {
      try {
        const current =
          await stripe.checkout.sessions.retrieve(
            session.id
          );

        if (current.status === "open") {
          const expired =
            await stripe.checkout.sessions.expire(
              session.id
            );

          safeToRelease =
            expired.status === "expired" &&
            expired.payment_status !== "paid";

        } else {
          safeToRelease =
            current.status === "expired" &&
            current.payment_status !== "paid";
        }

      } catch (expireError) {
        console.error(
          "Session cleanup failed:",
          expireError.message
        );
      }
    }

    if (
      reservationId &&
      supabase &&
      safeToRelease
    ) {
      const { error: releaseError } =
        await supabase.rpc("release_stock", {
          p_reservation_id: reservationId
        });

      if (releaseError) {
        console.error(
          "Stock release failed:",
          releaseError.message
        );
      }
    }

    return res.status(500).json({
      error: "Unable to start checkout. Please try again."
    });
  }
};
