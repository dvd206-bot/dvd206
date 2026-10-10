// api/klarna-shipping-callback.js

module.exports = async (req, res) => {
    // Sätt CORS- och content-type-headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=UTF-8');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Endast POST är tillåtet' });
    }

    const data = req.body || {};

    if (!data || Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'Ingen data mottagen' });
    }

    // -------------------------------------------------------------
    // POSTNORD API-KONFIGURATION
    // -------------------------------------------------------------
    const postnord_api_key    = process.env.POSTNORD_API_KEY || "DIN_POSTNORD_API_KEY";
    const sender_postal_code  = "90336";
    const sender_country_code = "SE";

    const shipping_address = data.shipping_address || {};
    const dest_country     = String(shipping_address.country || 'SE').toUpperCase();
    const dest_postal_code = String(shipping_address.postal_code || '').replace(/\s+/g, '');
    const currency         = String(data.purchase_currency || 'SEK').toUpperCase();

    const total_grams = parseInt(data.package_weight_grams, 10) || 400;
    const weight_kg   = Math.max(0.1, Number((total_grams / 1000).toFixed(2)));

    // Service-kod: 19 = MyPack Collect (Norden), 52 = PostNord Parcel (EU/Världen)
    const service_code = (dest_country === 'SE' || ['DK', 'FI', 'NO'].includes(dest_country)) ? '19' : '52';

    let shipping_options = [];

    // 1. Anropa PostNord Price API
    if (postnord_api_key !== "DIN_POSTNORD_API_KEY" && dest_postal_code) {
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
                const price_data = await priceRes.json();

                const calculated_amount = price_data.price?.amount ?? price_data.grossPrice ?? null;
                const vat_amount        = price_data.price?.vatAmount ?? price_data.vat ?? 0;

                if (calculated_amount !== null && calculated_amount !== undefined) {
                    const price_in_minor = Math.round(Number(calculated_amount) * 100);
                    const vat_in_minor   = Math.round(Number(vat_amount) * 100);

                    let service_point_name = "PostNord Utlämningsställe";

                    // Hämta närmaste fysiska ombud om inrikes
                    if (service_code === '19') {
                        try {
                            const spParams = new URLSearchParams({
                                apikey: postnord_api_key,
                                countryCode: dest_country,
                                postalCode: dest_postal_code,
                                numberOfServicePoints: '1'
                            });

                            const spRes = await fetch(`https://api2.postnord.com/rest/businesslocation/v5/servicepoints/nearest/byaddress?${spParams.toString()}`);
                            if (spRes.ok) {
                                const sp_data = await spRes.json();
                                const first_sp = sp_data.servicePointInformationResponse?.servicePoints?.[0];
                                if (first_sp?.name) {
                                    service_point_name = `PostNord Ombud --> ${first_sp.name}`;
                                }
                            }
                        } catch (err) {
                            // Vid eventuellt ombudsfel används standardnamnet
                        }
                    }

                    shipping_options.push({
                        id: `postnord_dynamic_${service_code}`,
                        name: service_point_name,
                        description: `Dynamisk fraktberäkning (${weight_kg} kg) från PostNord`,
                        price: price_in_minor,
                        tax_rate: (vat_in_minor > 0) ? 2500 : 0,
                        tax_amount: vat_in_minor,
                        preselected: true
                    });
                }
            }
        } catch (err) {
            console.error('Fel vid anrop mot PostNord Price API -->', err);
        }
    }

    if (shipping_options.length === 0) {
        if (postnord_api_key === "DIN_POSTNORD_API_KEY") {
            return res.status(200).json({
                error: "PostNord API-nyckel saknas i klarna-shipping-callback.js. Ange din nyckel från developer.postnord.com för att PostNord ska beräkna priset."
            });
        } else {
            return res.status(200).json({
                error: `PostNord kunde inte returnera ett pris för vikten ${weight_kg} kg och postnumret ${dest_postal_code} (${dest_country}).`
            });
        }
    }

    // 2. Beräkna Klarnas nya totalsumma
    const selected_shipping = shipping_options[0];
    let new_order_amount  = 0;
    let new_tax_amount    = 0;

    const order_lines = Array.isArray(data.order_lines) ? data.order_lines : [];
    for (const line of order_lines) {
        if ((line.type || '') !== 'shipping_fee') {
            new_order_amount += parseInt(line.total_amount, 10) || 0;
            new_tax_amount   += parseInt(line.total_tax_amount, 10) || 0;
        }
    }

    new_order_amount += selected_shipping.price;
    new_tax_amount   += selected_shipping.tax_amount;

    return res.status(200).json({
        order_amount: new_order_amount,
        order_tax_amount: new_tax_amount,
        shipping_options: shipping_options
    });
};