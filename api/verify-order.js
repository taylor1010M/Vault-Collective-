
const Stripe = require("stripe");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const sessionId = req.query.session_id;

    if (
      typeof sessionId !== "string" ||
      !/^cs_(test|live)_[a-zA-Z0-9]+$/.test(sessionId)
    ) {
      return res.status(400).json({
        error: "Invalid checkout reference."
      });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({
        error: "Verification unavailable."
      });
    }

    const stripe = new Stripe(
      process.env.STRIPE_SECRET_KEY
    );

    const session =
      await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.store !== "Vault Collective") {
      return res.status(404).json({
        error: "Order not found."
      });
    }

    if (
      session.status !== "complete" ||
      session.payment_status !== "paid"
    ) {
      return res.status(200).json({
        paid: false
      });
    }

    return res.status(200).json({
      paid: true,
      reference: "VC-" + session.id.slice(-12),
      total: session.amount_total,
      currency: session.currency
    });

  } catch (error) {
    console.error("Order verification failed:", error.message);

    return res.status(500).json({
      error: "Unable to verify order."
    });
  }
};
