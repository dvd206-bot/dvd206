// api/create-klarna-order.js

module.exports = async (req, res) => {
    // Sätt CORS- och innehålls-headers
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

    // -------------------------------------------------------------
    // KLARNA API-KONFIGURATION
    // Playground (Test) --> https://api.playground.klarna.com
    // Production (Skarpt) --> https://api.klarna.com
    // -------------------------------------------------------------
    const klarna_endpoint = process.env.KLARNA_ENDPOINT || "https://api.playground.klarna.com/checkout/v3/orders";
    const klarna_uid      = process.env.KLARNA_UID || "DITT_KLARNA_UID";
    const klarna_password = process.env.KLARNA_PASSWORD || "DITT_KLARNA_PASSWORD";
    // -------------------------------------------------------------

    const currency = String(data.currency || 'SEK').toUpperCase();
    const customer = data.customer || {};
    const country  = String(customer.country || (currency === 'SEK' ? 'SE' : 'US')).toUpperCase();
    const locale   = (country === 'SE' && currency === 'SEK') ? 'sv-SE' : 'en-US';

    const order_lines = [];
    let order_amount = 0;
    let order_tax_amount = 0;

    // 1. Bygg orderrader för produkterna
    data.items.forEach(item => {
        const qty = parseInt(item.quantity, 10) || 1;
        const unit_price = Math.round(Number(item.price) * 100); // Belopp i öre/cents
        const total_line_amount = unit_price * qty;

        // Momsberäkning (25 % moms inrikes/EU, 0 % utanför EU)
        const isEU = ['SE', 'DK', 'FI', 'DE', 'FR', 'NL', 'ES', 'IT', 'BE', 'AT', 'PL'].includes(country);
        const tax_rate = isEU ? 2500 : 0;
        const line_tax_amount = tax_rate > 0 ? Math.round(total_line_amount * 0.20) : 0;

        order_amount += total_line_amount;
        order_tax_amount += line_tax_amount;

        order_lines.push({
            type: "physical",
            name: item.name,
            quantity: qty,
            unit_price: unit_price,
            tax_rate: tax_rate,
            total_amount: total_line_amount,
            total_tax_amount: line_tax_amount
        });
    });

    // 2. Lägg till vald PostNord-frakt från steg 1 som en fast fraktrad
    const shipping_option = data.shipping_option || {
        id: 'postnord_standard',
        name: 'PostNord Frakt',
        price: 6900,
        tax_rate: 2500,
        tax_amount: 1380
    };

    const shipping_price = parseInt(shipping_option.price, 10) || 0;
    const shipping_tax_rate = shipping_option.tax_rate ?? 2500;
    const shipping_tax_amount = shipping_option.tax_amount ?? Math.round(shipping_price * 0.20);

    order_amount += shipping_price;
    order_tax_amount += shipping_tax_amount;

    order_lines.push({
        type: "shipping_fee",
        name: shipping_option.name || "PostNord Frakt",
        quantity: 1,
        unit_price: shipping_price,
        tax_rate: shipping_tax_rate,
        total_amount: shipping_price,
        total_tax_amount: shipping_tax_amount
    });

    // Fastställ basadressen från Vercel
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const base_url = `${protocol}://${host}`;

    // 3. Klarna Checkout-payload med förvald adress och låst frakt
    const payload = {
        purchase_country: country,
        purchase_currency: currency,
        locale: locale,
        order_amount: order_amount,
        order_tax_amount: order_tax_amount,
        order_lines: order_lines,
        billing_address: {
            given_name: customer.firstName || undefined,
            family_name: customer.lastName || undefined,
            email: customer.email || undefined,
            street_address: customer.street || undefined,
            postal_code: customer.zip || undefined,
            city: customer.city || undefined,
            country: country
        },
        shipping_address: {
            given_name: customer.firstName || undefined,
            family_name: customer.lastName || undefined,
            email: customer.email || undefined,
            street_address: customer.street || undefined,
            postal_code: customer.zip || undefined,
            city: customer.city || undefined,
            country: country
        },
        options: {
            allow_separate_shipping_address: false,
            shipping_details: `Vald leverans --> ${shipping_option.name}`
        },
        merchant_urls: {
            terms: `${base_url}/terms.html`,
            checkout: `${base_url}/checkout.html`,
            confirmation: `${base_url}/success.html?order_id={checkout.order.id}`,
            push: `${base_url}/api/create-order?order_id={checkout.order.id}`
        }
    };

    // Mock-läge om Klarna API-nycklar inte lagts till i Vercel ännu
    if (klarna_uid === "DITT_KLARNA_UID" || !process.env.KLARNA_UID) {
        return res.status(200).json({
            mock: true,
            message: "Klarna API-nycklar (KLARNA_UID / KLARNA_PASSWORD) saknas i Vercels miljövariabler. När du har lagt till dem laddas Klarnas betalningsfönster här med din valda PostNord-frakt.",
            order_amount: order_amount,
            shipping_applied: shipping_option
        });
    }

    // 4. Anropa Klarna Checkout API med Basic Auth
    try {
        const authString = Buffer.from(`${klarna_uid}:${klarna_password}`).toString('base64');
        const klarnaRes = await fetch(klarna_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${authString}`
            },
            body: JSON.stringify(payload)
        });

        const klarnaData = await klarnaRes.json();
        return res.status(klarnaRes.status).json(klarnaData);
    } catch (err) {
        return res.status(500).json({
            error: `Serverfel vid anrop mot Klarna --> ${err.message}`
        });
    }
};