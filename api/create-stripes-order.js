// api/create-stripes-order.js

function toFormUrlEncoded(obj, prefix = '') {
    const str = [];
    for (const p in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, p) && obj[p] !== undefined && obj[p] !== null) {
            const k = prefix ? `${prefix}[${p}]` : p;
            const v = obj[p];
            str.push((v !== null && typeof v === 'object')
                ? toFormUrlEncoded(v, k)
                : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
        }
    }
    return str.join('&');
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=UTF-8');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const data = req.body || {};

    if (!data || !Array.isArray(data.items) || data.items.length === 0) {
        return res.status(400).json({ error: 'Varukorgen är tom.' });
    }

    // Hämtar dina miljövariabler från Vercel
    const stripe_endpoint   = "https://api.stripe.com/v1/checkout/sessions";
    const stripe_secret_key = process.env.EMENDION_STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY;
    const stripe_public_key = process.env.EMENDION_STRIPE_PUBLIC_KEY || process.env.STRIPE_PUBLIC_KEY;

    const currencyRaw = String(data.currency || 'SEK').toUpperCase();
    const currency    = currencyRaw.toLowerCase();
    const rates       = { SEK: 1, USD: 0.095, EUR: 0.088 };
    const rate        = rates[currencyRaw] || 1;

    const customer        = data.customer || {};
    const shipping_option = data.shipping_option || {};
    const country         = String(customer.country || (currencyRaw === 'SEK' ? 'SE' : 'US')).toUpperCase();
    const locale          = (country === 'SE' && currencyRaw === 'SEK') ? 'sv' : 'en';

    const line_items = [];
    let order_amount = 0;
    let order_tax_amount = 0;

    const euCountries = ['SE', 'SWEDEN', 'SVERIGE', 'DK', 'DENMARK', 'DANMARK', 'FI', 'FINLAND', 'DE', 'GERMANY', 'TYSKLAND', 'FR', 'FRANCE', 'FRANKRIKE', 'NL', 'NETHERLANDS', 'ES', 'SPAIN', 'IT', 'ITALY', 'BE', 'BELGIUM', 'AT', 'AUSTRIA', 'PL', 'POLAND'];
    const isEU = euCountries.includes(country);

    data.items.forEach(item => {
        const qty = parseInt(item.quantity, 10) || 1;
        const convertedPrice = Math.round(Number(item.price) * rate);
        const unit_price = Math.round(convertedPrice * 100);
        const total_line_amount = unit_price * qty;

        const line_tax_amount = isEU ? Math.round(total_line_amount * 0.20) : 0;

        order_amount += total_line_amount;
        order_tax_amount += line_tax_amount;

        line_items.push({
            price_data: {
                currency: currency,
                unit_amount: unit_price,
                product_data: {
                    name: item.name
                }
            },
            quantity: qty
        });
    });

    const shipping_price_sek_minor = parseInt(shipping_option.price, 10) || 0;
    const shipping_price = Math.round((shipping_price_sek_minor / 100) * rate) * 100;
    const shipping_tax_amount = isEU ? Math.round(shipping_price * 0.20) : 0;

    order_amount += shipping_price;
    order_tax_amount += shipping_tax_amount;

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const base_url = `${protocol}://${host}`;

    const ui_mode = data.ui_mode === 'embedded' ? 'embedded' : 'hosted';

    const payload = {
        mode: 'payment',
        locale: locale,
        customer_email: customer.email || undefined,
        line_items: line_items,
        shipping_options: [
            {
                shipping_rate_data: {
                    type: 'fixed_amount',
                    fixed_amount: {
                        amount: shipping_price,
                        currency: currency
                    },
                    display_name: shipping_option.name || "PostNord Frakt"
                }
            }
        ],
        metadata: {
            customer_name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim(),
            customer_phone: customer.phone || '',
            shipping_street: customer.street || '',
            shipping_zip: customer.zip || '',
            shipping_city: customer.city || '',
            shipping_country: customer.country || '',
            shipping_method: `Vald leverans --> ${shipping_option.name || 'PostNord'}`,
            estimated_tax_minor: String(order_tax_amount)
        }
    };

    if (ui_mode === 'embedded') {
        payload.ui_mode = 'embedded';
        payload.return_url = `${base_url}/success.html?order_id={CHECKOUT_SESSION_ID}`;
    } else {
        payload.success_url = `${base_url}/success.html?order_id={CHECKOUT_SESSION_ID}`;
        payload.cancel_url = `${base_url}/checkout.html`;
    }

    // Testläge om EMENDION_STRIPE_SECRET_KEY saknas i Vercel
    if (!stripe_secret_key) {
        return res.status(200).json({
            mock: true,
            message: "Stripe API-nyckel (EMENDION_STRIPE_SECRET_KEY) är inte tillagd än.",
            order_amount: order_amount,
            shipping_applied: shipping_option
        });
    }

    try {
        const stripeRes = await fetch(stripe_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Bearer ${stripe_secret_key}`
            },
            body: toFormUrlEncoded(payload)
        });

        const stripeData = await stripeRes.json();

        if (!stripeRes.ok) {
            return res.status(stripeRes.status).json({
                error: stripeData.error?.message || 'Ett fel uppstod hos Stripe.',
                details: stripeData
            });
        }

        return res.status(200).json({
            id: stripeData.id,
            url: stripeData.url,
            client_secret: stripeData.client_secret,
            public_key: stripe_public_key
        });
    } catch (err) {
        return res.status(500).json({
            error: `Serverfel vid anrop mot Stripe --> ${err.message}`
        });
    }
};