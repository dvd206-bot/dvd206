// api/send-order.js
const nodemailer = require('nodemailer');

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

    const mailUser = process.env.LOOPIA_EMAIL || 'order@emendion.com';
    const mailPass = process.env.LOOPIA_EMAIL_PASS || 'perspolis11x';

    // Loopia SMTP via port 587 (STARTTLS) för stabil anslutning från Vercel
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

    // Formatera artikellistan för mejlet
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
    const shippingName = shipping?.name || 'PostNord';
    const shippingDesc = shipping?.description || customer.street || '';

    const mailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b; background: #ffffff; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px;">
            <div style="margin-bottom: 24px;">
                <h2 style="color: #0f172a; margin: 0 0 6px 0; font-size: 22px;">Tack för din beställning hos Emendion!</h2>
                <p style="font-size: 13px; color: #64748b; margin: 0; font-family: monospace;">Ordernummer --> <strong>${order_id || 'BEKRÄFTAD'}</strong></p>
            </div>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">

            <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 0 0 10px 0;">Leveransdetaljer</h3>
            <p style="font-size: 14px; line-height: 1.6; margin: 0; color: #334155;">
                <strong>Mottagare --></strong> ${customer.firstName} ${customer.lastName}<br>
                <strong>Mobil för SMS-avi --></strong> ${customer.phone || 'Ej angivet'}<br>
                <strong>Leveranssätt --></strong> ${shippingName}<br>
                <strong>Plats / Ombud --></strong> ${shippingDesc}
            </p>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">

            <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin: 0 0 10px 0;">Beställda artiklar</h3>
            <table style="width: 100%; font-size: 14px; border-collapse: collapse; margin-bottom: 12px;">
                ${itemsHtml}
                <tr>
                    <td style="padding: 10px 0 6px 0; color: #64748b;">Frakt (${shippingName})</td>
                    <td style="padding: 10px 0 6px 0; text-align: right; font-family: monospace; font-weight: 600; color: #0f172a;">${shippingPrice} kr</td>
                </tr>
                <tr>
                    <td style="padding: 12px 0 0 0; font-weight: bold; font-size: 16px; border-top: 2px solid #0f172a; color: #0f172a;">Totalt att betala</td>
                    <td style="padding: 12px 0 0 0; text-align: right; font-weight: bold; font-size: 16px; border-top: 2px solid #0f172a; font-family: monospace; color: #2563eb;">${total_amount} kr</td>
                </tr>
            </table>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0 16px 0;">
            <p style="font-size: 12px; color: #94a3b8; margin: 0; text-align: center;">Emendion • Vi skickar ditt paket så snart det har packats.</p>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"Emendion" <${mailUser}>`,
            to: customer.email,                           // Skickas till kunden
            bcc: mailUser,                                // Skickar kopia direkt till din egen Loopia-inkorg
            subject: `Orderbekräftelse #${order_id || ''} - Emendion`,
            html: mailHtml
        });

        return res.status(200).json({ success: true, message: "Bekräftelsemejl skickat." });
    } catch (err) {
        console.error("Fel vid Loopia SMTP-anrop -->", err);
        return res.status(500).json({ error: `Kunde inte skicka mejl --> ${err.message}` });
    }
};