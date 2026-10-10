// api/klarna-shipping-callback.js

module.exports = async (req, res) => {
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
    const dest_street      = String(shipping_address.street_address || '').trim();

    if (!dest_postal_code) {
        return res.status(400).json({ error: "Postnummer saknas." });
    }

    const total_grams = parseInt(data.package_weight_grams, 10) || 180;
    const weight_kg   = Math.max(0.1, Number((total_grams / 1000).toFixed(2)));

    const isNordic = ['SE', 'DK', 'FI', 'NO'].includes(dest_country);
    const service_code = isNordic ? '19' : '52';

    // -------------------------------------------------------------
    // 1. HÄMTA OMBUD LIVE FRÅN POSTNORD SERVICE POINT API (v5)
    // -------------------------------------------------------------
    let ombud_list = [];

    if (isNordic) {
        try {
            const spParams = new URLSearchParams({
                apikey: postnord_api_key,
                countryCode: dest_country,
                postalCode: dest_postal_code,
                numberOfServicePoints: '4' // Hämtar de 4 närmaste fysiska ombuden
            });

            if (dest_street) {
                spParams.append('streetName', dest_street);
            }

            const spRes = await fetch(`https://api2.postnord.com/rest/businesslocation/v5/servicepoints/nearest/byaddress?${spParams.toString()}`, {
                headers: { 'Accept': 'application/json' }
            });

            if (spRes.ok) {
                const spData = await spRes.json();
                ombud_list = spData?.servicePointInformationResponse?.servicePoints || [];
            } else {
                console.warn(`ServicePoint API svarade med HTTP ${spRes.status}`);
            }
        } catch (err) {
            console.error("Fel vid hämtning av ombud -->", err);
        }
    }

    // -------------------------------------------------------------
    // 2. PRISBERÄKNING (FÖRSÖK LIVE, ANNARS OFFENTLIG PORTOTAXA)
    // -------------------------------------------------------------
    let live_price_sek = null;

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

        const priceRes = await fetch(`https://api2.postnord.com/rest/transport/v1/price?${priceParams.toString()}`, {
            headers: { 'Accept': 'application/json' }
        });

        if (priceRes.ok) {
            const priceData = await priceRes.json();
            const val = priceData?.price?.amount ?? priceData?.grossPrice ?? priceData?.netAmount;
            if (val !== undefined && val !== null && !isNaN(Number(val))) {
                live_price_sek = Number(val);
            }
        }
    } catch (e) {
        // Ignorera fel i Price API och gå vidare med PostNords portotabell
    }

    // Om Price API inte har aktiverats för ditt konto används PostNords officiella portotabell
    if (live_price_sek === null) {
        if (dest_country === 'SE') {
            live_price_sek = weight_kg <= 1.0 ? 69 : 89;
        } else if (isNordic) {
            live_price_sek = 129;
        } else if (['DE', 'FR', 'NL', 'GB', 'ES', 'IT'].includes(dest_country)) {
            live_price_sek = 169;
        } else {
            live_price_sek = 229;
        }
    }

    const price_in_minor = Math.round(live_price_sek * 100);
    const tax_rate       = isNordic ? 2500 : 0;
    const tax_in_minor   = Math.round(price_in_minor * (tax_rate > 0 ? 0.20 : 0));

    // -------------------------------------------------------------
    // 3. BYGG ALTERNATIVEN MED POSTNORDS RIKTIGA OMBUD
    // -------------------------------------------------------------
    let shipping_options = [];

    if (ombud_list.length > 0) {
        // Skapa ett alternativ per fysiskt ombud som PostNord returnerade
        ombud_list.forEach((sp, idx) => {
            const street = sp.visitingAddress?.streetName ? `${sp.visitingAddress.streetName}` : '';
            const city = sp.visitingAddress?.city || '';
            const distance = sp.routeDistance ? ` (${(sp.routeDistance / 1000).toFixed(1)} km bort)` : '';

            shipping_options.push({
                id: `pn_sp_${sp.servicePointId}`,
                name: `PostNord Ombud: ${sp.name}`,
                description: `${street}, ${city}${distance}`,
                service_point_id: sp.servicePointId,
                price: price_in_minor,
                tax_rate: tax_rate,
                tax_amount: tax_in_minor,
                preselected: idx === 0
            });
        });
    } else {
        // För internationell adress eller om ombud saknas
        shipping_options.push({
            id: `pn_${service_code}`,
            name: isNordic ? "PostNord MyPack Collect" : `PostNord Tracked Priority (${dest_country})`,
            description: `Spårbar transport direkt till adressen (${weight_kg} kg)`,
            price: price_in_minor,
            tax_rate: tax_rate,
            tax_amount: tax_in_minor,
            preselected: true
        });
    }

    // Beräkna Klarna order amounts
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