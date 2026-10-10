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

    // -------------------------------------------------------------
    // 1. BERÄKNA BASPRIS (POSTNORD LIVE PRICE ELLER PORTOTABELL)
    // -------------------------------------------------------------
    let base_collect_price = null;

    try {
        const priceParams = new URLSearchParams({
            apikey: postnord_api_key,
            returnType: 'json',
            fromCountryCode: sender_country_code,
            fromPostalCode: sender_postal_code,
            toCountryCode: dest_country,
            toPostalCode: dest_postal_code,
            weight: weight_kg.toString(),
            serviceCode: isNordic ? '19' : '52'
        });

        const priceRes = await fetch(`https://api2.postnord.com/rest/transport/v1/price?${priceParams.toString()}`, {
            headers: { 'Accept': 'application/json' }
        });

        if (priceRes.ok) {
            const priceData = await priceRes.json();
            const val = priceData?.price?.amount ?? priceData?.grossPrice ?? priceData?.netAmount;
            if (val !== undefined && val !== null && !isNaN(Number(val))) {
                base_collect_price = Number(val);
            }
        }
    } catch (e) {
        // Går vidare till portotabell om Price API kräver avtal
    }

    if (base_collect_price === null) {
        if (dest_country === 'SE') {
            base_collect_price = weight_kg <= 1.0 ? 69 : 89;
        } else if (isNordic) {
            base_collect_price = 129;
        } else if (['DE', 'FR', 'NL', 'GB', 'ES', 'IT'].includes(dest_country)) {
            base_collect_price = 169;
        } else {
            base_collect_price = 229;
        }
    }

    const collect_minor = Math.round(base_collect_price * 100);
    const home_minor    = collect_minor + 6000; // +60 kr för hemleverans direkt till dörren
    const tax_rate      = isNordic ? 2500 : 0;

    // -------------------------------------------------------------
    // 2. HÄMTA NÄRMASTE OMBUD LIVE FRÅN POSTNORD SERVICE POINT API
    // -------------------------------------------------------------
    let ombud_list = [];

    if (isNordic) {
        try {
            // Försök 1: Sök med gatuadress och postnummer
            const spParams = new URLSearchParams({
                apikey: postnord_api_key,
                returnType: 'json',
                countryCode: dest_country,
                postalCode: dest_postal_code,
                numberOfServicePoints: '5'
            });

            if (dest_street) {
                // Skicka med gatunamn för exakt avstånd
                spParams.append('streetName', dest_street);
            }

            let spRes = await fetch(`https://api2.postnord.com/rest/businesslocation/v5/servicepoints/nearest/byaddress?${spParams.toString()}`, {
                headers: { 'Accept': 'application/json' }
            });

            if (spRes.ok) {
                const spData = await spRes.json();
                ombud_list = spData?.servicePointInformationResponse?.servicePoints || [];
            }

            // Försök 2: Fallback på enbart postnummer om gatuadressen inte gav träff
            if (ombud_list.length === 0) {
                const fallbackUrl = `https://api2.postnord.com/rest/businesslocation/v5/servicepoints/bypostalcode?apikey=${encodeURIComponent(postnord_api_key)}&returnType=json&countryCode=${encodeURIComponent(dest_country)}&postalCode=${encodeURIComponent(dest_postal_code)}`;
                const fbRes = await fetch(fallbackUrl, { headers: { 'Accept': 'application/json' } });
                if (fbRes.ok) {
                    const fbData = await fbRes.json();
                    ombud_list = fbData?.servicePointInformationResponse?.servicePoints || [];
                }
            }
        } catch (err) {
            console.error("Fel vid uppslag av PostNord-ombud -->", err);
        }
    }

    // -------------------------------------------------------------
    // 3. SKAPA STRUKTURERADE LEVERANSALTERNATIV
    // -------------------------------------------------------------
    let shipping_options = [];

    // Alternativ A --> Hemleverans direkt till dörren
    const streetText = dest_street ? `${dest_street}, ${dest_postal_code}` : `din adress (${dest_postal_code})`;
    shipping_options.push({
        id: "postnord_home",
        type: "home",
        name: isNordic ? "PostNord Hemleverans (Direkt till dörren)" : `PostNord Home Delivery (${dest_country})`,
        description: `Levereras direkt hem till ${streetText}`,
        price: home_minor,
        tax_rate: tax_rate,
        tax_amount: Math.round(home_minor * (tax_rate > 0 ? 0.20 : 0)),
        preselected: false
    });

    // Alternativ B --> Ombud / Utlämningsställen
    if (ombud_list.length > 0) {
        ombud_list.forEach((sp, idx) => {
            const streetName = sp.visitingAddress?.streetName ? `${sp.visitingAddress.streetName}` : '';
            const streetNumber = sp.visitingAddress?.streetNumber ? ` ${sp.visitingAddress.streetNumber}` : '';
            const city = sp.visitingAddress?.city || '';
            const distance = sp.routeDistance ? ` (${(sp.routeDistance / 1000).toFixed(1)} km bort)` : '';

            shipping_options.push({
                id: `pn_sp_${sp.servicePointId}`,
                type: "pickup_point",
                name: `PostNord Ombud --> ${sp.name}`,
                description: `${streetName}${streetNumber}, ${city}${distance}`,
                service_point_id: sp.servicePointId,
                service_point_name: sp.name,
                service_point_address: `${streetName}${streetNumber}, ${city}`,
                price: collect_minor,
                tax_rate: tax_rate,
                tax_amount: Math.round(collect_minor * (tax_rate > 0 ? 0.20 : 0)),
                preselected: idx === 0 // Första ombudet är förvalt
            });
        });
    } else {
        // Internationellt eller om inga ombud finns i registret
        shipping_options.push({
            id: "postnord_parcel_collect",
            type: "pickup_point",
            name: `PostNord Tracked Parcel (${dest_country})`,
            description: `Spårbar transport via närmaste lokala utlämningsställe (${dest_postal_code})`,
            price: collect_minor,
            tax_rate: tax_rate,
            tax_amount: Math.round(collect_minor * (tax_rate > 0 ? 0.20 : 0)),
            preselected: true
        });
    }

    // Se till att det första alternativet alltid är markerat som förvalt
    shipping_options.forEach((opt, idx) => {
        opt.preselected = (idx === 0); // Första alternativet är förvalt
    });

    return res.status(200).json({
        shipping_options: shipping_options
    });
};