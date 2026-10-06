<?php
// Tillåt anrop och sätt JSON-svar
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Headers: Content-Type");
header("Content-Type: application/json; charset=UTF-8");

// Ta emot rådata från JavaScript
$input = file_get_contents("php://input");
$data = json_decode($input, true);

if (!$data || empty($data['customer']) || empty($data['items'])) {
    http_response_code(400);
    echo json_encode(["error" => "Ofullständig orderdata."]);
    exit;
}

$customer = $data['customer'];
$items = $data['items'];
$total = htmlspecialchars($data['total']);
$currency = htmlspecialchars($data['currency'] ?? 'SEK');
$orderId = 'EMD-' . strtoupper(substr(uniqid(), -6));
$orderDate = date("Y-m-d H:i:s");

// Bygg rader för beställda produkter
$itemsHtml = '';
foreach ($items as $item) {
    $name = htmlspecialchars($item['name']);
    $qty = (int)$item['quantity'];
    $price = htmlspecialchars($item['price']);
    $itemsHtml .= "
    <tr style='border-bottom: 1px solid #e2e8f0;'>
        <td style='padding: 10px 8px; font-size: 14px;'>{$name}</td>
        <td style='padding: 10px 8px; font-size: 14px; text-align: center;'>{$qty} st</td>
        <td style='padding: 10px 8px; font-size: 14px; text-align: right; font-family: monospace;'>{$price} {$currency}</td>
    </tr>";
}

// Bygg HTML-meddelandet
$custName = htmlspecialchars($customer['firstName'] . ' ' . $customer['lastName']);
$custEmail = htmlspecialchars($customer['email']);
$custStreet = htmlspecialchars($customer['street']);
$custZip = htmlspecialchars($customer['zip']);
$custCity = htmlspecialchars($customer['city']);

$message = "
<html>
<head><title>Ny Order {$orderId}</title></head>
<body style='font-family: Arial, sans-serif; background-color: #f8fafc; padding: 20px;'>
  <div style='max-width: 600px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;'>
    <div style='background-color: #0f172a; padding: 20px; color: #ffffff;'>
      <h2 style='margin: 0; font-size: 18px; letter-spacing: 1px;'>NY BESTÄLLNING MOTTAGEN</h2>
      <p style='margin: 4px 0 0 0; font-size: 12px; color: #94a3b8; font-family: monospace;'>Order-ID --> {$orderId} | {$orderDate}</p>
    </div>
    
    <div style='padding: 24px;'>
      <h3 style='font-size: 13px; text-transform: uppercase; color: #64748b; margin-top: 0;'>Leveransadress & Kund</h3>
      <div style='background: #f8fafc; padding: 14px; border-radius: 8px; font-size: 14px; line-height: 1.5; margin-bottom: 24px;'>
        <strong>{$custName}</strong><br>
        {$custStreet}<br>
        {$custZip} {$custCity}<br>
        <span style='color: #64748b;'>E-post --></span> <a href='mailto:{$custEmail}'>{$custEmail}</a>
      </div>

      <h3 style='font-size: 13px; text-transform: uppercase; color: #64748b;'>Beställda artiklar</h3>
      <table style='width: 100%; border-collapse: collapse; margin-bottom: 20px;'>
        <thead>
          <tr style='text-align: left; font-size: 12px; color: #64748b; border-bottom: 2px solid #e2e8f0;'>
            <th style='padding: 8px;'>Artikel</th>
            <th style='padding: 8px; text-align: center;'>Antal</th>
            <th style='padding: 8px; text-align: right;'>Pris</th>
          </tr>
        </thead>
        <tbody>
          {$itemsHtml}
        </tbody>
      </table>

      <div style='text-align: right; border-top: 2px solid #0f172a; padding-top: 12px;'>
        <span style='font-size: 13px; color: #64748b;'>Totalsumma --> </span>
        <strong style='font-size: 20px; font-family: monospace; color: #0f172a;'>{$total}</strong>
      </div>
    </div>
    
    <div style='background: #f8fafc; padding: 12px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;'>
      Skickat automatiskt via Emendion Webbshop på Loopia
    </div>
  </div>
</body>
</html>";

$to = "order@emendion.com"; 

$subject = "Ny Order #{$orderId} --> {$custName}";

// E-posthuvuden för HTML-format
$headers = "MIME-Version: 1.0\r\n";
$headers .= "Content-type: text/html; charset=UTF-8\r\n";
$headers .= "From: Emendion System <{$to}>\r\n";
$headers .= "Reply-To: {$custEmail}\r\n";

// Skicka mejlet via Loopias server
if (mail($to, $subject, $message, $headers)) {
    echo json_encode(["success" => true, "orderId" => $orderId]);
} else {
    http_response_code(500);
    echo json_encode(["error" => "Kunde inte skicka mejlet via servern."]);
}
?>