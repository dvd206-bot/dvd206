// api/create-klarna-order.js

module.exports = async (req, res) => {
    // Sätt CORS- och innehålls-headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    // KLARNA API-UPPGIFTER (Läggs i Vercel Environment Variables eller direkt här)
    // Playground (Test) --> https://api.playground.klarna.com
    // Production (Skarpt) --> https://api.klarna.com
    // -------------------------------------------------------------
    const klarna_endpoint = "https://api.playground.klarna.com/checkout/v3/orders";
    const klarna_uid      = process.env.KLARNA_UID || "DITT_KLARNA_UID";
    const klarna_password = process.env.KLARNA_PASSWORD || "DITT_KLARNA_PASSWORD";
    // -------------------------------------------------------------

    const currency = String(data.currency || 'SEK').toUpperCase();
    const locale   = (currency === 'SEK') ? 'sv-SE' : 'en-US';
    const country  = (currency === 'SEK') ? 'SE' : 'US';

    const order_lines = [];
    let order_amount = 0;
    let order_tax_amount = 0;

    // 1. Bygg orderrader för produkterna
    data.items.forEach(item => {
        const qty = parseInt(item.quantity, 10) || 1;
        // Klarna räknar belopp i minor units (öre/cents)
        const unit_price = Math.round(Number(item.price) * 100);
        const total_line_amount = unit_price * qty;
        const line_tax_amount = Math.round(total_line_amount * 0.20); // 25 % moms (20 % av bruttopriset)

        order_amount += total_line_amount;
        order_tax_amount += line_tax_amount;

        order_lines.push({
            type: "physical",
            name: item.name,
            quantity: qty,
            unit_price: unit_price,
            tax_rate: 2500, // 25.00 %
            total_amount: total_line_amount,
            total_tax_amount: line_tax_amount
        });
    });

    // 2. Definiera PostNord-fraktalternativ vid laddning (Inrikes SE vs Internationellt)
    let shipping_options = [];

    if (country === 'SE') {
        shipping_options = [
            {
                id: "postnord_mypack_collect",
                name: "PostNord Ombud (MyPack Collect)",
                description: "Leverans till närmaste utlämningsställe (1-2 vardagar)",
                price: 6900, // 69 kr
                tax_rate: 2500, // 25 % moms
                tax_amount: 1380,
                preselected: true
            },
            {
                id: "postnord_mypack_home",
                name: "PostNord Hemleverans",
                description: "Leverans direkt till dörren (1-2 vardagar)",
                price: 12900, // 129 kr
                tax_rate: 2500,
                tax_amount: 2580,
                preselected: false
            }
        ];
    } else {
        shipping_options = [
            {
                id: "postnord_parcel_world",
                name: "PostNord Tracked Priority (Worldwide)",
                description: "Tracked airmail courier delivery (4-8 business days)",
                price: 24900, // 249 kr / motsvarande valuta
                tax_rate: 0, // 0 % moms vid export utanför EU
                tax_amount: 0,
                preselected: true
            }
        ];
    }

    // 3. Addera förvalt PostNord-fraktalternativ till totalbeloppet
    const default_shipping = shipping_options[0];
    order_amount += default_shipping.price;
    order_tax_amount += default_shipping.tax_amount;

    // Hämta korrekt hostadress från Vercels headers
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const base_url = `${protocol}://${host}`;

    // 4. Skapa Klarna-payload med frakt och address_update callback
    const payload = {
        purchase_country: country,
        purchase_currency: currency,
        locale: locale,
        order_amount: order_amount,
        order_tax_amount: order_tax_amount,
        order_lines: order_lines,
        shipping_options: shipping_options,
        options: {
            allow_separate_shipping_address: true,
            shipping_details: "Leverans via PostNord med full spårning."
        },
        merchant_urls: {
            terms: `${base_url}/terms.html`,
            checkout: `${base_url}/checkout.html`,
            confirmation: `${base_url}/success.html?order_id={checkout.order.id}`,
            push: `${base_url}/api/create-order?order_id={checkout.order.id}`,
            // Peker nu på JavaScript-versionen av shipping callback:
            address_update: `${base_url}/api/klarna-shipping-callback`
        }
    };

    // Om inga nycklar lagts in ännu --> returnera pedagogiskt mock-svar
    if (klarna_uid === "DITT_KLARNA_UID") {
        return res.status(200).json({
            mock: true,
            message: "Klarna API-nycklar saknas. Lägg in ditt UID och lösenord i Vercels inställningar eller api/create-klarna-order.js när du har ett Klarna-konto."
        });
    }

    // 5. Anropa Klarna Checkout API med Basic Auth
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