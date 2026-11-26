
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  let claimedEventId = null;
  let supabase = null;

  try {
    const {
      STRIPE_SECRET_KEY,
      STRIPE_WEBHOOK_SECRET,
      SUPABASE_URL,
      SUPABASE_SECRET_KEY
    } = process.env;

    if (
      !STRIPE_SECRET_KEY ||
      !STRIPE_WEBHOOK_SECRET ||
      !SUPABASE_URL ||
      !SUPABASE_SECRET_KEY
    ) {
      throw new Error("Incomplete server configuration");
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY);

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

    const signature = req.headers["stripe-signature"];

    if (!signature) {
      return res.status(400).json({
        error: "Missing Stripe signature"
      });
    }

    const rawBody = await readRawBody(req);

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch {
      return res.status(400).json({
        error: "Invalid Stripe signature"
      });
    }

    // Atomically claim this event before processing it.
    const { data: claimResult, error: claimError } =
      await supabase.rpc("claim_stripe_event", {
        p_event_id: event.id,
        p_event_type: event.type
      });

    if (claimError) throw claimError;

    if (claimResult === "processed") {
      return res.status(200).json({
        received: true,
        duplicate: true
      });
    }

    if (claimResult !== "claimed") {
      // Ask Stripe to retry if another request is processing it.
      return res.status(500).json({
        error: "Event is currently being processed"
      });
    }

    claimedEventId = event.id;

    const session = event.data.object;

    const reservationId =
      session.metadata?.reservation_id || null;

    const releaseEvents = [
      "checkout.session.expired",
      "checkout.session.async_payment_failed"
    ];

    const paymentEvents = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded"
    ];

    // Release stock when a checkout expires or payment fails.
    if (
      releaseEvents.includes(event.type) &&
      reservationId
    ) {
      const current =
        await stripe.checkout.sessions.retrieve(session.id);

      if (current.payment_status !== "paid") {
        const { data: reservation, error } =
          await supabase
            .from("stock_reservations")
            .select("id,stripe_session_id")
            .eq("id", reservationId)
            .single();

        if (error) throw error;

        if (reservation.stripe_session_id !== session.id) {
          throw new Error("Reservation session mismatch");
        }

        const { error: releaseError } =
          await supabase.rpc("release_stock", {
            p_reservation_id: reservationId
          });

        if (releaseError) throw releaseError;
      }
    }

    // Save paid orders and complete their stock reservations.
    if (
      paymentEvents.includes(event.type) &&
      session.payment_status === "paid"
    ) {
      const lineItems =
        await stripe.checkout.sessions.listLineItems(
          session.id,
          {
            limit: 100,
            expand: ["data.price.product"]
          }
        );

      if (lineItems.has_more) {
        throw new Error("Unexpected number of order items");
      }

      const customer = session.customer_details || {};

      const shipping =
        session.collected_information?.shipping_details ||
        session.shipping_details ||
        {};

      const orderData = {
        stripe_checkout_session_id: session.id,

        stripe_payment_intent_id:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : session.payment_intent?.id || null,

        status: "paid",
        currency: session.currency || "gbp",
        subtotal_pence: session.amount_subtotal || 0,

        shipping_pence:
          session.total_details?.amount_shipping || 0,

        total_pence: session.amount_total || 0,

        customer_email:
          customer.email ||
          session.customer_email ||
          null,

        customer_name:
          shipping.name ||
          customer.name ||
          null,

        shipping_address:
          shipping.address ||
          customer.address ||
          null,

        updated_at: new Date().toISOString()
      };

      const { data: order, error: orderError } =
        await supabase
          .from("orders")
          .upsert(orderData, {
            onConflict: "stripe_checkout_session_id"
          })
          .select("id,stock_deducted")
          .single();

      if (orderError) throw orderError;

      if (!order.stock_deducted) {
        const items = lineItems.data.map(item => {
          const product = item.price?.product;

          const sku =
            typeof product === "object"
              ? product.metadata?.sku
              : null;

          if (!sku) {
            throw new Error("Missing product SKU");
          }

          return {
            order_id: order.id,
            sku,

            product_name:
              item.description ||
              "Vault Collective product",

            unit_amount_pence:
              item.price?.unit_amount || 0,

            quantity: item.quantity || 1
          };
        });

        const { data: existingItems, error: lookupError } =
          await supabase
            .from("order_items")
            .select("id")
            .eq("order_id", order.id);

        if (lookupError) throw lookupError;

        if (!existingItems.length) {
          const { error: itemsError } =
            await supabase
              .from("order_items")
              .insert(items);

          if (itemsError) throw itemsError;
        }
      }

      if (reservationId) {
        const { error: stockError } =
          await supabase.rpc(
            "complete_stock_reservation",
            {
              p_reservation_id: reservationId,
              p_order_id: order.id
            }
          );

        if (stockError) throw stockError;

      } else if (!order.stock_deducted) {
        const { error: stockError } =
          await supabase.rpc(
            "deduct_order_stock",
            {
              p_order_id: order.id
            }
          );

        if (stockError) throw stockError;
      }
    }

    // Only mark the event processed after all work succeeds.
    const { data: finished, error: finishError } =
      await supabase.rpc("finish_stripe_event", {
        p_event_id: event.id
      });

    if (finishError) throw finishError;

    if (finished !== true) {
      throw new Error("Could not mark Stripe event as processed");
    }

    claimedEventId = null;

    return res.status(200).json({
      received: true
    });

  } catch (error) {
    console.error("Order webhook error:", error.message);

    // Mark failed so Stripe can safely retry the event.
    if (claimedEventId && supabase) {
      const { error: failError } =
        await supabase.rpc("fail_stripe_event", {
          p_event_id: claimedEventId,
          p_error: error.message || "Unknown processing error"
        });

      if (failError) {
        console.error(
          "Could not release event claim:",
          failError.message
        );
      }
    }

    return res.status(500).json({
      error: "Webhook could not be processed"
    });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
