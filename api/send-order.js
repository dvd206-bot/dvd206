// api/send-order.js
const nodemailer = require('nodemailer');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { customer, shipping, items, order_id, total_amount } = req.body || {};

    if (!customer || !customer.email) {
        return res.status(400).json({ error: 'Kunduppgifter saknas.' });
    }

    // Loopias SMTP-inställningar
    const transporter = nodemailer.createTransport({
        host: 'mailcluster.loopia.se',
        port: 465,
        secure: true, // SSL
        auth: {
            user:'order@emendion.com',     // ex. order@emendion.com
            pass:'perspolis11x'
        }
    });

    // Formatera artikellistan för mejlet
    const itemsHtml = (items || []).map(i => `
        <tr>
            <td style="padding: 6px 0; border-bottom: 1px solid #eee;">${i.name} × ${i.quantity}</td>
            <td style="padding: 6px 0; border-bottom: 1px solid #eee; text-align: right; font-family: monospace;">${i.price * i.quantity} kr</td>
        </tr>
    `).join('');

    const mailHtml = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
            <h2 style="color: #0f172a; margin-bottom: 4px;">Tack för din beställning hos Emendion!</h2>
            <p style="font-size: 14px; color: #64748b;">Ordernummer --> <strong>${order_id || 'BEKRÄFTAD'}</strong></p>
            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">

            <h3 style="font-size: 15px; margin-bottom: 8px;">Leveransdetaljer</h3>
            <p style="font-size: 14px; line-height: 1.6; margin: 0;">
                <strong>Mottagare --></strong> ${customer.firstName} ${customer.lastName}<br>
                <strong>Mobil för SMS-avi --></strong> ${customer.phone}<br>
                <strong>Leveranssätt --></strong> ${shipping?.name || 'PostNord'}<br>
                <strong>Plats / Adress --></strong> ${shipping?.description || customer.street}
            </p>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">

            <h3 style="font-size: 15px; margin-bottom: 8px;">Beställda artiklar</h3>
            <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
                ${itemsHtml}
                <tr>
                    <td style="padding: 10px 0 4px; font-weight: bold;">Frakt</td>
                    <td style="padding: 10px 0 4px; text-align: right; font-family: monospace;">${Math.round((shipping?.price || 0) / 100)} kr</td>
                </tr>
                <tr>
                    <td style="padding: 8px 0; font-weight: bold; font-size: 16px; border-top: 2px solid #0f172a;">Totalt</td>
                    <td style="padding: 8px 0; text-align: right; font-weight: bold; font-size: 16px; border-top: 2px solid #0f172a; font-family: monospace;">${total_amount} kr</td>
                </tr>
            </table>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;">
            <p style="font-size: 12px; color: #94a3b8;">Emendion • Vi skickar ditt paket så snart det har packats.</p>
        </div>
    `;

    try {
        await transporter.sendMail({
            from: `"Emendion" <${process.env.LOOPIA_EMAIL}>`,
            to: customer.email,                           // Skickas till kunden
            bcc: process.env.LOOPIA_EMAIL,                 // Skickar kopia direkt till din egen inkorg!
            subject: `Orderbekräftelse #${order_id || ''} - Emendion`,
            html: mailHtml
        });

        return res.status(200).json({ success: true, message: "Bekräftelsemejl skickat." });
    } catch (err) {
        console.error("Fel vid mejlutskick -->", err);
        return res.status(500).json({ error: "Kunde inte skicka mejl --> " + err.message });
    }
};