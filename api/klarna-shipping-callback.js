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

    // POSTNORD API
    const postnord_api_key         = process.env.POSTNORD_API_KEY || "0dcf57ae801653934a0b868e8fb81f87";
    const sender_postal_code       = "90336"; 
    const sender_country_code      = "SE";

    const shipping_address = data.shipping_address || {};
    const dest_country     = String(shipping_address.country || 'SE').toUpperCase();
    const dest_postal_code = String(shipping_address.postal_code || '').replace(/\s+/g, '');
    const dest_street      = String(shipping_address.street_address || '').trim();

    if (!dest_postal_code) {
        return res.status(400).json({ error: "Postnummer saknas." });
    }

    const isNordic = ['SE', 'DK', 'FI', 'NO'].includes(dest_country);


    // beräknande av baspris (POSTNORD LIVE PRICE ELLER PORTOTABELL)
    let home_minor = 0;
    let collect_minor = 0;

    if (dest_country === 'SE') {
        home_minor    = 5520; // 55,20 kr (Home Small Prio)
        collect_minor = 8400; // 84,00 kr (Service Point)
    } else if (isNordic) {
        home_minor    = 11900; // Tracked Letter Norden
        collect_minor = 13900; // Pickup Point Norden
    } else if (['DE', 'FR', 'NL', 'GB', 'ES', 'IT', 'AT', 'BE', 'PL'].includes(dest_country)) {
        home_minor    = 13900; // Tracked Letter Europa
        collect_minor = 16900; // Parcel Collect Europa
    } else {
        home_minor    = 17900; // Tracked Letter Övriga världen (ex. AU/US)
        collect_minor = 22900; // Tracked Parcel Övriga världen
    }

    const tax_rate = isNordic ? 2500 : 0;

    // hämta närmaste ombud (postnord service point API) -- fungerar enbart till elverans i norden

    let ombud_list = [];

    if (isNordic) {
        try {
            // Sök med gatuadress och postnummer
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

            // Fallback på enbart postnummer om gatuadressen inte gav någon träff
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

    // skapa leveransalternativ

    let shipping_options = [];

    // Hemleverans direkt till dörren
    const streetText = dest_street ? `${dest_street}, ${dest_postal_code}` : `your address (${dest_postal_code})`;
    shipping_options.push({
        id: "postnord_home",
        type: "home",
        name: isNordic ? "PostNord Hemleverans (Home Small Prio)" : `PostNord Home Delivery (${dest_country})`,
        description: `Delivers to ${streetText}`,
        price: home_minor,
        tax_rate: tax_rate,
        tax_amount: Math.round(home_minor * (tax_rate > 0 ? 0.20 : 0)),
        preselected: false
    });

    // Ombud / Utlämningsställen
    if (ombud_list.length > 0) {
        ombud_list.forEach((sp, idx) => {
            const streetName = sp.visitingAddress?.streetName ? `${sp.visitingAddress.streetName}` : '';
            const streetNumber = sp.visitingAddress?.streetNumber ? ` ${sp.visitingAddress.streetNumber}` : '';
            const city = sp.visitingAddress?.city || '';
            const distance = sp.routeDistance ? ` (${(sp.routeDistance / 1000).toFixed(1)} km away)` : '';

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
        // Internationellt eller om inga ombud finns i registret (utanför norden)
        shipping_options.push({
            id: "postnord_parcel_collect",
            type: "pickup_point",
            name: `PostNord Tracked Parcel (${dest_country})`,
            description: `Tracked transport via nearest local pickup point (${dest_postal_code})`,
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