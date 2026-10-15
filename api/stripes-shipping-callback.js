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

    const shipping_address = data.shipping_address || {};
    const dest_country     = String(shipping_address.country || 'SE').trim().toUpperCase();
    const dest_postal_code = String(shipping_address.postal_code || '').replace(/\s+/g, '');
    const dest_street      = String(shipping_address.street_address || '').trim();

    if (!dest_postal_code) {
        return res.status(400).json({ error: "Postnummer saknas." });
    }

    const isSweden = ['SE', 'SWEDEN', 'SVERIGE'].includes(dest_country);
    const isNordic = isSweden || ['DK', 'DENMARK', 'DANMARK', 'FI', 'FINLAND', 'NO', 'NORWAY', 'NORGE'].includes(dest_country);
    const isEurope = ['DE', 'GERMANY', 'TYSKLAND', 'FR', 'FRANCE', 'FRANKRIKE', 'NL', 'NETHERLANDS', 'NEDERLÄNDERNA', 'GB', 'UK', 'UNITED KINGDOM', 'STORBRITANNIEN', 'ES', 'SPAIN', 'SPANIEN', 'IT', 'ITALY', 'ITALIEN', 'AT', 'AUSTRIA', 'ÖSTERRIKE', 'BE', 'BELGIUM', 'BELGIEN', 'PL', 'POLAND', 'POLEN'].includes(dest_country);

    // beräknande av baspris (250g)
    let home_minor = 0;
    let collect_minor = 0;

    if (isSweden) {
        home_minor    = 5520;  // 55,20 kr (Home Small Prio)
        collect_minor = 8400;  // 84,00 kr (Service Point)
    } else if (isNordic) {
        home_minor    = 11825; // 118,25 kr (PostNord Tracked Letter enstaka 250g: 105 kr + 0,25 * 53 kr)
        collect_minor = 17100; // 171,00 kr (Rek utrikes EDI Europa 250g)
    } else if (isEurope) {
        home_minor    = 11825; // 118,25 kr (PostNord Tracked Letter enstaka 250g: 105 kr + 0,25 * 53 kr)
        collect_minor = 17100; // 171,00 kr (Rek utrikes EDI Europa 250g)
    } else {
        home_minor    = 11825; // 118,25 kr (PostNord Tracked Letter enstaka 250g: 105 kr + 0,25 * 53 kr)
        collect_minor = 18000; // 180,00 kr (Rek utrikes EDI Utanför Europa 250g)
    }

    const tax_rate = isNordic ? 2500 : 0;

    // skapa leveransalternativ
    let shipping_options = [];

    // Hemleverans direkt till dörren
    const streetText = dest_street ? `${dest_street}, ${dest_postal_code}` : `your address (${dest_postal_code})`;
    shipping_options.push({
        id: "postnord_home",
        type: "home",
        name: isNordic ? "PostNord Homedelivery (Home Small Prio)" : `PostNord Home Delivery (${dest_country})`,
        description: `Delivers to ${streetText}`,
        price: home_minor,
        tax_rate: tax_rate,
        tax_amount: Math.round(home_minor * (tax_rate > 0 ? 0.20 : 0)),
        preselected: true
    });

    // Leverans till utlämningsställe
    shipping_options.push({
        id: "postnord_parcel_collect",
        type: "pickup_point",
        name: `PostNord Tracked Parcel (${dest_country})`,
        description: `Tracked transport via nearest local pickup point (${dest_postal_code})`,
        price: collect_minor,
        tax_rate: tax_rate,
        tax_amount: Math.round(collect_minor * (tax_rate > 0 ? 0.20 : 0)),
        preselected: false
    });

    return res.status(200).json({
        shipping_options: shipping_options
    });
};