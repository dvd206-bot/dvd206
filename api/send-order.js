// api/send-order.js
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');

// Gör om långa Stripe-session-ID:n (cs_test_...) till ett snyggt 6-siffrigt ordernummer
function formatOrderNumber(rawId) {
    if (!rawId || String(rawId).toUpperCase().includes('TEST-ORD')) {
        return String(Math.floor(100000 + Math.random() * 900000));
    }
    const str = String(rawId).trim();
    if (/^\d{5,8}$/.test(str)) {
        return str;
    }
    // Skapa ett konsekvent 6-siffrigt nummer utifrån Stripe-sessionens ID
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) % 900000;
    }
    return String(100000 + Math.abs(hash));
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=UTF-8');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Endast POST är tillåtet' });

    const { customer, shipping, items, order_id, total_amount } = req.body || {};

    if (!customer || !customer.email) {
        return res.status(400).json({ error: 'Kunduppgifter eller e-post saknas.' });
    }

    // Generera snyggt 6-siffrigt ordernummer
    const finalOrderId = formatOrderNumber(order_id);

    // Spara ordern i Loopia MariaDB (matchar dina variabelnamn i Vercel)
    let dbSuccess = false;
    let dbError = null;

    try {
        const db = await mysql.createConnection({
            host: (process.env.DATABASE_HOST || process.env.LOOPIA_DB_HOST || '').trim(),
            user: (process.env.DATABAS_ANVANDARNAMN || process.env.LOOPIA_DB_USER || '').trim(),
            password: (process.env.DATABAS_LOSENORD || process.env.LOOPIA_DB_PASSWORD || '').trim(),
            database: (process.env.DATABAS_NAME || process.env.LOOPIA_DB_NAME || '').trim(),
            connectTimeout: 8000
        });

        const insertSql = `
            INSERT INTO orders (
                order_id, first_name, last_name, email, phone,
                street_address, postal_code, city, country,
                shipping_cost,
                items_json, total_amount
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE total_amount = VALUES(total_amount)
        `;

        const shippingCost = shipping?.price ? Math.round(Number(shipping.price) / 100) : 0;

        await db.execute(insertSql, [
            finalOrderId,
            customer.firstName || '',
            customer.lastName || '',
            customer.email,
            customer.phone || '',
            customer.street || '',
            customer.zip || '',
            customer.city || '',
            customer.country || 'SE',
            shippingCost,
            JSON.stringify(items || []),
            total_amount || 0
        ]);

        await db.end();
        dbSuccess = true;
    } catch (err) {
        console.error("Fel vid sparning till Loopia DB -->", err);
        dbError = err.message;
    }

    // Orderbekräftelsemejl via Loopia (läser LOOPIA_EMAIL_ADRESS från Vercel)
    const mailUser = (process.env.LOOPIA_EMAIL_ADRESS || process.env.LOOPIA_EMAIL_ADDRESS || process.env.LOOPIA_EMAIL || '').trim();
    const mailPass = (process.env.LOOPIA_EMAIL_PASS || '').trim();

    const transporter = nodemailer.createTransport({
        host: 'mailcluster.loopia.se',
        port: 587,
        secure: false,
        auth: {
            user: mailUser,
            pass: mailPass
        },
        tls: {
            rejectUnauthorized: false
        }
    });

    const itemsHtml = (items || []).map(i => {
        const qty = parseInt(i.quantity, 10) || 1;
        const lineTotal = (Number(i.price) || 0) * qty;
        return `
            <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #334155;">${i.name} × ${qty}</td>
                <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; text-align: right; font-family: monospace; font-weight: 600; color: #0f172a;">${lineTotal} kr</td>
            </tr>
        `;
    }).join('');

    const shippingPrice = shipping?.price ? Math.round(Number(shipping.price) / 100) : 0;

    const mailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; background: #ffffff; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
            <div style="margin-bottom: 24px;">
                <h2 style="color: #0f172a; margin: 0 0 6px 0; font-size: 22px;">Thank you for your order at Emendion!</h2>
                <p style="font-size: 13px; color: #64748b; margin: 0; font-family: monospace;">Order number --> <strong>#${finalOrderId}</strong></p>
            </div>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">

            <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 0 0 10px 0;">Order Specification</h3>
            <p style="font-size: 14px; line-height: 1.6; margin: 0; color: #334155;">
                <strong>Recipient --></strong> ${customer.firstName} ${customer.lastName}<br>
                <strong>Phone-Number --></strong> ${customer.phone || 'Ej angivet'}<br>
                <strong>Location / Dropoff --></strong> ${customer.street || ''}, ${customer.zip || ''} ${customer.city || ''}
            </p>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">

            <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 0 0 10px 0;">Order Items</h3>
            <table style="width: 100%; font-size: 14px; border-collapse: collapse; margin-bottom: 12px;">
                ${itemsHtml}
                <tr>
                    <td style="padding: 10px 0 6px 0; color: #64748b;">Frakt</td>
                    <td style="padding: 10px 0 6px 0; text-align: right; font-family: monospace; font-weight: 600; color: #0f172a;">${shippingPrice} kr</td>
                </tr>
                <tr>
                    <td style="padding: 12px 0 0 0; font-weight: bold; font-size: 16px; border-top: 2px solid #0f172a; color: #0f172a;">Total Amount</td>
                    <td style="padding: 12px 0 0 0; text-align: right; font-weight: bold; font-size: 16px; border-top: 2px solid #0f172a; font-family: monospace; color: #2563eb;">${total_amount} kr</td>
                </tr>
            </table>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0 16px 0;">
            <p style="font-size: 12px; color: #94a3b8; margin: 0; text-align: center;">Sincerely, Emendion</p>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"Emendion" <${mailUser}>`,
            to: customer.email,
            bcc: mailUser,
            subject: `Orderbekräftelse #${finalOrderId} Emendion`,
            html: mailHtml
        });

        return res.status(200).json({ 
            success: true, 
            order_id: finalOrderId,
            db_saved: dbSuccess,
            db_error: dbError,
            message: "Bekräftelsemejl skickat och order sparad i databas." 
        });
    } catch (err) {
        console.error("Fel vid Loopia SMTP-anrop -->", err);
        return res.status(500).json({ 
            error: `Kunde inte skicka mejl (användare: ${mailUser || 'SAKNAS'}) --> ${err.message}`,
            order_id: finalOrderId,
            db_saved: dbSuccess,
            db_error: dbError
        });
    }
};