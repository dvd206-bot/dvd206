<?php
// create-klarna-order.php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Headers: Content-Type");
header("Content-Type: application/json; charset=UTF-8");

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(["error" => "Method not allowed"]);
    exit;
}

$input = file_get_contents("php://input");
$data = json_decode($input, true);

if (!$data || empty($data['items'])) {
    http_response_code(400);
    echo json_encode(["error" => "Varukorgen är tom."]);
    exit;
}

// -------------------------------------------------------------
// KLARNA API-UPPGIFTER (Fyll i när du har konto)
// Playground (Test) --> https://api.playground.klarna.com
// Production (Skarpt) --> https://api.klarna.com
// -------------------------------------------------------------
$klarna_endpoint = "https://api.playground.klarna.com/checkout/v3/orders";
$klarna_uid      = "DITT_KLARNA_UID";       // Fylls i senare
$klarna_password = "DITT_KLARNA_PASSWORD";  // Fylls i senare
// -------------------------------------------------------------

$currency = strtoupper($data['currency'] ?? 'SEK');
$locale   = ($currency === 'SEK') ? 'sv-SE' : 'en-US';
$country  = ($currency === 'SEK') ? 'SE' : 'US';

$order_lines = [];
$order_amount = 0;
$order_tax_amount = 0;

// 1. Bygg orderrader för produkterna
foreach ($data['items'] as $item) {
    $qty = (int)$item['quantity'];
    // Klarna räknar belopp i minor units (öre/cents)
    $unit_price = (int)round($item['price'] * 100);
    $total_line_amount = $unit_price * $qty;
    $line_tax_amount = (int)round($total_line_amount * 0.20); // 25 % moms (20 % av bruttopriset)

    $order_amount += $total_line_amount;
    $order_tax_amount += $line_tax_amount;

    $order_lines[] = [
        "type"             => "physical",
        "name"             => $item['name'],
        "quantity"         => $qty,
        "unit_price"       => $unit_price,
        "tax_rate"         => 2500, // 25.00 %
        "total_amount"     => $total_line_amount,
        "total_tax_amount" => $line_tax_amount
    ];
}

// 2. Definiera PostNord-fraktalternativ vid laddning (Inrikes SE vs Internationellt)
$shipping_options = [];

if ($country === 'SE') {
    $shipping_options = [
        [
            "id"          => "postnord_mypack_collect",
            "name"        => "PostNord Ombud (MyPack Collect)",
            "description" => "Leverans till närmaste utlämningsställe (1-2 vardagar)",
            "price"       => 6900, // 69 kr
            "tax_rate"    => 2500, // 25 % moms
            "tax_amount"  => 1380,
            "preselected" => true
        ],
        [
            "id"          => "postnord_mypack_home",
            "name"        => "PostNord Hemleverans",
            "description" => "Leverans direkt till dörren (1-2 vardagar)",
            "price"       => 12900, // 129 kr
            "tax_rate"    => 2500,
            "tax_amount"  => 2580,
            "preselected" => false
        ]
    ];
} else {
    // För internationella köp initieras PostNord Tracked Priority
    $shipping_options = [
        [
            "id"          => "postnord_parcel_world",
            "name"        => "PostNord Tracked Priority (Worldwide)",
            "description" => "Tracked airmail courier delivery (4-8 business days)",
            "price"       => 24900, // 249 kr / motsvarande valuta
            "tax_rate"    => 0,     // 0 % moms vid export utanför EU
            "tax_amount"  => 0,
            "preselected" => true
        ]
    ];
}

// 3. Addera förvalt PostNord-fraktalternativ till totalbeloppet
$default_shipping = $shipping_options[0];
$order_amount += $default_shipping['price'];
$order_tax_amount += $default_shipping['tax_amount'];

$protocol = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? "https://" : "http://";
$host = $_SERVER['HTTP_HOST'];
$base_url = $protocol . $host;

// 4. Skapa Klarna-payload med frakt och address_update callback
$payload = [
    "purchase_country"  => $country,
    "purchase_currency" => $currency,
    "locale"            => $locale,
    "order_amount"      => $order_amount,
    "order_tax_amount"  => $order_tax_amount,
    "order_lines"       => $order_lines,
    "shipping_options"  => $shipping_options,
    "options"           => [
        "allow_separate_shipping_address" => true,
        "shipping_details" => "Leverans via PostNord med full spårning."
    ],
    "merchant_urls"     => [
        "terms"          => $base_url . "/terms.html",
        "checkout"       => $base_url . "/checkout.html",
        "confirmation"   => $base_url . "/success.html?order_id={checkout.order.id}",
        "push"           => $base_url . "/send-order.php?order_id={checkout.order.id}",
        // Anropas när kunden byter land eller postnummer i Klarna:
        "address_update" => $base_url . "/klarna-shipping-callback.php"
    ]
];

// Om inga nycklar lagts in ännu --> returnera pedagogiskt mock-svar
if ($klarna_uid === "DITT_KLARNA_UID") {
    echo json_encode([
        "mock" => true,
        "message" => "Klarna API-nycklar saknas. Lägg in ditt UID och lösenord i create-klarna-order.php när du skapat ditt Klarna-konto."
    ]);
    exit;
}

$ch = curl_init($klarna_endpoint);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
curl_setopt($ch, CURLOPT_USERPWD, $klarna_uid . ":" . $klarna_password);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "Content-Type: application/json"
]);

$response = curl_exec($ch);
$http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($http_code >= 200 && $http_code < 300) {
    echo $response;
} else {
    http_response_code($http_code);
    echo $response;
}
?>