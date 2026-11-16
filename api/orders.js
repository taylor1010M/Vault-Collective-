
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

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
      throw new Error("Server configuration is incomplete.");
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY);

    const supabase = createClient(
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
      return send(res, 400, { error: "Missing Stripe signature." });
    }

    const rawBody = await readRawBody(req);

    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      STRIPE_WEBHOOK_SECRET
    );

    const { data: previousEvent, error: eventCheckError } =
      await supabase
        .from("stripe_events")
        .select("event_id")
        .eq("event_id", event.id)
        .maybeSingle();

    if (eventCheckError) throw eventCheckError;

    if (previousEvent) {
      return send(res, 200, { received: true });
    }

    const supportedEvents = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded"
    ];

    if (supportedEvents.includes(event.type)) {
      const session = event.data.object;

      if (session.payment_status === "paid") {
        const lineItems = await stripe.checkout.sessions.listLineItems(
          session.id,
          { limit: 100 }
        );

        const customer = session.customer_details || {};
        const address =
          session.shipping_details?.address ||
          customer.address ||
          null;

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
          customer_email: customer.email || session.customer_email || null,
          customer_name: customer.name || null,
          shipping_address: address,
          updated_at: new Date().toISOString()
        };

        const { data: existingOrder, error: lookupError } =
          await supabase
            .from("orders")
            .select("id")
            .eq("stripe_checkout_session_id", session.id)
            .maybeSingle();

        if (lookupError) throw lookupError;

        let order;

        if (existingOrder) {
          const { data, error } = await supabase
            .from("orders")
            .update(orderData)
            .eq("id", existingOrder.id)
            .select("id")
            .single();

          if (error) throw error;
          order = data;
        } else {
          const { data, error } = await supabase
            .from("orders")
            .insert(orderData)
            .select("id")
            .single();

          if (error) throw error;
          order = data;
        }

        const items = lineItems.data.map((item) => ({
          order_id: order.id,
          sku: item.price?.id || item.id,
          product_name: item.description || "Vault Collective product",
          unit_amount_pence: item.amount_total
            ? Math.round(item.amount_total / (item.quantity || 1))
            : item.price?.unit_amount || 0,
          quantity: item.quantity || 1
        }));

        const { error: deleteError } = await supabase
          .from("order_items")
          .delete()
          .eq("order_id", order.id);

        if (deleteError) throw deleteError;

        if (items.length) {
          const { error: itemsError } = await supabase
            .from("order_items")
            .insert(items);

          if (itemsError) throw itemsError;
        }
      }
    }

    const { error: saveEventError } = await supabase
      .from("stripe_events")
      .insert({
        event_id: event.id,
        event_type: event.type
      });

    if (saveEventError) throw saveEventError;

    return send(res, 200, { received: true });

  } catch (error) {
    console.error("Order webhook error:", error.message);

    return send(res, 400, {
      error: "Webhook could not be processed."
    });
  }
};

// Disable automatic body parsing so Stripe's signature
// can be checked against the original request body.
module.exports.config = {
  api: {
    bodyParser: false
  }
};
