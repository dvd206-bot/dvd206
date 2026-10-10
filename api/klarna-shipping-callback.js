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
        return res.status(400).json({ error: "Postnummer måste anges för att hämta live-pris från PostNord." });
    }

    const total_grams = parseInt(data.package_weight_grams, 10) || 180;
    const weight_kg   = Math.max(0.1, Number((total_grams / 1000).toFixed(2)));

    // Service-koder hos PostNord:
    // 19 = PostNord MyPack Collect (Ombud inrikes & Norden)
    // 52 = PostNord Parcel (Europa / Världen)
    const isNordic = ['SE', 'DK', 'FI', 'NO'].includes(dest_country);
    const service_code = isNordic ? '19' : '52';

    // -------------------------------------------------------------
    // 1. HÄMTA PRIS LIVE FRÅN POSTNORD PRICE API (INGA FÖRBESTÄMDA PRISER)
    // -------------------------------------------------------------
    let live_price_amount = null;
    let live_vat_amount = 0;
    let price_error = null;

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
            headers: {
                'Accept': 'application/json'
            }
        });

        const priceText = await priceRes.text();
        let priceData = {};
        try {
            priceData = JSON.parse(priceText);
        } catch (e) {
            price_error = `PostNord Price API svarade inte med JSON (HTTP ${priceRes.status}): ${priceText.substring(0, 120)}`;
        }

        if (priceRes.ok && priceData) {
            const rawAmount = priceData?.price?.amount ?? priceData?.grossPrice ?? priceData?.netAmount;
            if (rawAmount !== undefined && rawAmount !== null && !isNaN(Number(rawAmount))) {
                live_price_amount = Number(rawAmount);
                live_vat_amount   = Number(priceData?.price?.vatAmount ?? priceData?.vat ?? 0);
            } else {
                price_error = priceData?.message || priceData?.error || "PostNord returnerade inget pris för angiven rutt/vikt.";
            }
        } else if (!price_error) {
            price_error = priceData?.message || priceData?.compositeFault?.faults?.[0]?.explanationText || `PostNord avvisade prisberäkningen (Status ${priceRes.status}).`;
        }
    } catch (err) {
        price_error = `Kunde inte kontakta PostNord Price API --> ${err.message}`;
    }

    if (live_price_amount === null) {
        return res.status(400).json({
            error: price_error || "Inget pris kunde hämtas live från PostNord för denna adress och vikt."
        });
    }

    const price_in_minor = Math.round(live_price_amount * 100);
    const vat_in_minor   = Math.round(live_vat_amount * 100);
    const tax_rate       = (vat_in_minor > 0 && price_in_minor > 0) ? Math.round((vat_in_minor / (price_in_minor - vat_in_minor)) * 10000) : 0;

    // -------------------------------------------------------------
    // 2. HÄMTA OMBUD LIVE FRÅN POSTNORD SERVICE POINT API
    // -------------------------------------------------------------
    let shipping_options = [];

    if (isNordic) {
        try {
            const spParams = new URLSearchParams({
                apikey: postnord_api_key,
                countryCode: dest_country,
                postalCode: dest_postal_code,
                numberOfServicePoints: '5'
            });

            if (dest_street) {
                spParams.append('streetName', dest_street);
            }

            const spRes = await fetch(`https://api2.postnord.com/rest/businesslocation/v5/servicepoints/nearest/byaddress?${spParams.toString()}`, {
                headers: {
                    'Accept': 'application/json'
                }
            });

            if (spRes.ok) {
                const spData = await spRes.json();
                const points = spData?.servicePointInformationResponse?.servicePoints || [];

                points.forEach((sp, idx) => {
                    const street = sp.visitingAddress?.streetName ? `${sp.visitingAddress.streetName}` : '';
                    const city = sp.visitingAddress?.city || '';
                    const distance = sp.routeDistance ? ` (${(sp.routeDistance / 1000).toFixed(1)} km)` : '';

                    shipping_options.push({
                        id: `pn_sp_${sp.servicePointId}`,
                        name: `PostNord Ombud --> ${sp.name}`,
                        description: `${street}, ${city}${distance}`,
                        service_point_id: sp.servicePointId,
                        price: price_in_minor,
                        tax_rate: tax_rate,
                        tax_amount: vat_in_minor,
                        preselected: idx === 0
                    });
                });
            }
        } catch (err) {
            console.error("Fel vid hämtning av ombud -->", err);
        }
    }

    // Om inga ombud hittas eller vid internationell frakt (utanför Norden)
    if (shipping_options.length === 0) {
        shipping_options.push({
            id: `pn_live_${service_code}`,
            name: isNordic ? "PostNord MyPack Collect" : `PostNord Tracked Parcel (${dest_country})`,
            description: `Live PostNord-taxa (${weight_kg} kg) till ${dest_postal_code}`,
            price: price_in_minor,
            tax_rate: tax_rate,
            tax_amount: vat_in_minor,
            preselected: true
        });
    }

    // Beräkna totalsummor för ordern
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