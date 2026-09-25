// api/create-checkout-session.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Endast POST är tillåtet' });
  }

  try {
    const { items, customerEmail } = req.body;

    // Bygg upp raderna som kunden ska betala för
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'sek',
        product_data: {
          name: item.name,
          // Lägg till bildlänk här om du vill att bilden ska synas i Stripe Checkout
        },
        unit_amount: Math.round(item.price * 100), // Stripe räknar alltid i ören (100 kr = 10000)
      },
      quantity: item.quantity || 1,
    }));

    // Skapa en säker session hos Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: customerEmail,
      line_items: lineItems,
      mode: 'payment',
      // Tillåt internationell leveransadress direkt i Stripes kassa
      shipping_address_collection: {
        allowed_countries: ['SE', 'NO', 'DK', 'FI', 'DE', 'GB', 'US'],
      },
      // Vart kunden skickas efter betalning
      success_url: `${req.headers.origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/index.html`,
    });

    // Returnera URL:en till frontend
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message });
  }
};