// api/klarna-shipping-callback.js

module.exports = async (req, res) => {
    // Sätt CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=UTF-8');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Endast POST är tillåtet' });
    }

    const data = req.body || {};

    // -------------------------------------------------------------
    // POSTNORD API-KONFIGURATION
    // -------------------------------------------------------------
    const postnord_api_key    = process.env.POSTNORD_API_KEY || "0dcf57ae801653934a0b868e8fb81f87";
    const sender_postal_code  = "90336"; // Umeå
    const sender_country_code = "SE";

    const shipping_address = data.shipping_address || {};
    const dest_country     = String(shipping_address.country || 'SE').toUpperCase();
    const dest_postal_code = String(shipping_address.postal_code || '').replace(/\s+/g, '');

    const total_grams = parseInt(data.package_weight_grams, 10) || 180;
    const weight_kg   = Math.max(0.1, Number((total_grams / 1000).toFixed(2)));

    // Service-koder hos PostNord:
    // 19 = PostNord MyPack Collect (Ombud inrikes & Norden)
    // 52 = PostNord MyPack Home / Parcel
    const service_code = (dest_country === 'SE' || ['DK', 'FI', 'NO'].includes(dest_country)) ? '19' : '52';

    let calculated_price_sek = null;
    let service_point_name   = dest_country === 'SE' ? "PostNord Ombud (MyPack Collect)" : "PostNord Tracked Parcel";

    // 1. Slå upp närmaste PostNord-ombud via Service Point API (v5)
    if (postnord_api_key && postnord_api_key !== "DIN_POSTNORD_API_KEY" && dest_postal_code) {
        try {
            const spUrl = `https://api2.postnord.com/rest/businesslocation/v5/servicepoints/nearest/byaddress?apikey=${encodeURIComponent(postnord_api_key)}&countryCode=${encodeURIComponent(dest_country)}&postalCode=${encodeURIComponent(dest_postal_code)}&numberOfServicePoints=1`;
            const spRes = await fetch(spUrl);
            
            if (spRes.ok) {
                const spData = await spRes.json();
                const points = spData?.servicePointInformationResponse?.servicePoints;
                if (Array.isArray(points) && points.length > 0 && points[0]?.name) {
                    const sp = points[0];
                    const street = sp.visitingAddress?.streetName ? ` (${sp.visitingAddress.streetName})` : '';
                    service_point_name = `PostNord Ombud --> ${sp.name}${street}`;
                }
            }
        } catch (e) {
            console.error("Fel vid Service Point-uppslag -->", e);
        }
    }

    // 2. Slå upp dynamiskt pris från PostNord Price API
    if (postnord_api_key && postnord_api_key !== "DIN_POSTNORD_API_KEY" && dest_postal_code) {
        try {
            const priceParams = new URLSearchParams({
                apikey: postnord_api_key,
                fromCountryCode: sender_country_code,
                fromPostalCode: sender_postal_code,
                toCountryCode: dest_country,
                toPostalCode: dest_postal_code,
                weight: weight_kg.toString(),
                serviceCode: service_code
            });

            const priceRes = await fetch(`https://api2.postnord.com/rest/transport/v1/price?${priceParams.toString()}`);
            
            if (priceRes.ok) {
                const priceData = await priceRes.json();
                const amount = priceData?.price?.amount ?? priceData?.grossPrice ?? priceData?.netAmount;
                if (amount !== undefined && amount !== null && !isNaN(Number(amount))) {
                    calculated_price_sek = Number(amount);
                }
            }
        } catch (e) {
            console.error("Fel vid Price API-uppslag -->", e);
        }
    }

    // Om PostNord Price API inte returnerar belopp (ex. kräver kundavtal), använd dynamisk viktbaserad taxa:
    if (calculated_price_sek === null) {
        if (dest_country === 'SE') {
            // Baserat på PostNords standard portotabell för paket/ombud:
            calculated_price_sek = weight_kg <= 0.5 ? 59 : (weight_kg <= 1.0 ? 69 : 89);
        } else if (['DK', 'FI', 'NO'].includes(dest_country)) {
            calculated_price_sek = 129;
        } else {
            calculated_price_sek = 199;
        }
    }

    // Konvertera till minor units (öre/cent)
    const price_in_minor = Math.round(calculated_price_sek * 100);
    const tax_rate       = 2500; // 25 % moms
    const tax_in_minor   = Math.round(price_in_minor * 0.20);

    const shipping_options = [
        {
            id: `postnord_${service_code}`,
            name: service_point_name,
            description: `Vikt: ${total_grams} g | Levereras inom 1-2 vardagar`,
            price: price_in_minor,
            tax_rate: tax_rate,
            tax_amount: tax_in_minor,
            preselected: true
        }
    ];

    // Beräkna Klarna totalsummor
    let new_order_amount = 0;
    let new_tax_amount   = 0;

    const order_lines = Array.isArray(data.order_lines) ? data.order_lines : [];
    for (const line of order_lines) {
        if ((line.type || '') !== 'shipping_fee') {
            new_order_amount += parseInt(line.total_amount, 10) || 0;
            new_tax_amount   += parseInt(line.total_tax_amount, 10) || 0;
        }
    }

    new_order_amount += shipping_options[0].price;
    new_tax_amount   += shipping_options[0].tax_amount;

    return res.status(200).json({
        order_amount: new_order_amount,
        order_tax_amount: new_tax_amount,
        shipping_options: shipping_options
    });
};