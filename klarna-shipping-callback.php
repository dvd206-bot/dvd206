<?php
// klarna-shipping-callback.php
header("Content-Type: application/json; charset=UTF-8");

$input = file_get_contents("php://input");
$data = json_decode($input, true);

if (!$data) {
    http_response_code(400);
    echo json_encode(["error" => "Ingen data mottagen"]);
    exit;
}

// -------------------------------------------------------------
// POSTNORD API-KONFIGURATION
// -------------------------------------------------------------
$postnord_api_key     = "0dcf57ae801653934a0b868e8fb81f87"; // Din nyckel från Applications-tabellen
$sender_postal_code   = "90336";                // Umeå
$sender_country_code  = "SE";
// -------------------------------------------------------------

$shipping_address = $data['shipping_address'] ?? [];
$dest_country     = strtoupper($shipping_address['country'] ?? 'SE');
$dest_postal_code = preg_replace('/\s+/', '', $shipping_address['postal_code'] ?? '');
$currency         = strtoupper($data['purchase_currency'] ?? 'SEK');

// Beräkna totalvikt i kilogram (minst 0.1 kg för att PostNord ska beräkna)
$total_grams = (int)($data['package_weight_grams'] ?? 400);
$weight_kg = max(0.1, round($total_grams / 1000, 2));

// Tjänstekoder hos PostNord -->
// 19 = MyPack Collect (Ombud inrikes & Norden)
// 18 = MyPack Home (Hemleverans)
// 52 = PostNord Parcel (Internationellt EU/Världen)
$service_code = ($dest_country === 'SE' || in_array($dest_country, ['DK', 'FI', 'NO'])) ? '19' : '52';

$shipping_options = [];

// 1. ANROPA POSTNORD PRICE API FÖR DYNAMISKT PRIS
if ($postnord_api_key !== "DIN_POSTNORD_API_KEY" && !empty($dest_postal_code)) {
    
    $price_url = "https://api2.postnord.com/rest/transport/v1/price?" . http_build_query([
        'apikey'          => $postnord_api_key,
        'fromCountryCode' => $sender_country_code,
        'fromPostalCode'  => $sender_postal_code,
        'toCountryCode'   => $dest_country,
        'toPostalCode'    => $dest_postal_code,
        'weight'          => $weight_kg,
        'serviceCode'     => $service_code
    ]);

    $ch = curl_init($price_url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 4);
    $price_response = curl_exec($ch);
    $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($http_code === 200 && $price_response) {
        $price_data = json_decode($price_response, true);
        
        // Hämta belopp från PostNords svar
        $calculated_amount = $price_data['price']['amount'] ?? $price_data['grossPrice'] ?? null;
        $vat_amount        = $price_data['price']['vatAmount'] ?? $price_data['vat'] ?? 0;

        if ($calculated_amount !== null) {
            // Konvertera till minor units (öre/cent) för Klarna
            $price_in_minor = (int)round($calculated_amount * 100);
            $vat_in_minor   = (int)round($vat_amount * 100);

            // Hämta även närmaste fysiska ombudsnamn via Service Point API om tillämpligt
            $service_point_name = "PostNord Utlämningsställe";
            if ($service_code === '19') {
                $sp_url = "https://api2.postnord.com/rest/businesslocation/v5/servicepoints/nearest/byaddress?" . http_build_query([
                    'apikey'      => $postnord_api_key,
                    'countryCode' => $dest_country,
                    'postalCode'  => $dest_postal_code,
                    'numberOfServicePoints' => 1
                ]);
                $sp_res = @file_get_contents($sp_url);
                if ($sp_res) {
                    $sp_json = json_decode($sp_res, true);
                    $first_sp = $sp_json['servicePointInformationResponse']['servicePoints'][0] ?? null;
                    if ($first_sp) {
                        $service_point_name = "PostNord Ombud --> " . $first_sp['name'];
                    }
                }
            }

            $shipping_options[] = [
                "id"          => "postnord_dynamic_" . $service_code,
                "name"        => $service_point_name,
                "description" => "Dynamisk fraktberäkning ({$weight_kg} kg) från PostNord",
                "price"       => $price_in_minor,
                "tax_rate"    => ($vat_in_minor > 0) ? 2500 : 0,
                "tax_amount"  => $vat_in_minor,
                "preselected" => true
            ];
        }
    }
}

// Om API-nyckel ännu inte matats in, skicka meddelande till gränssnittet
if (empty($shipping_options)) {
    if ($postnord_api_key === "DIN_POSTNORD_API_KEY") {
        echo json_encode([
            "error" => "PostNord API-nyckel saknas i klarna-shipping-callback.php. Ersätt DIN_POSTNORD_API_KEY med nyckeln från developer.postnord.com för att PostNord ska beräkna priset."
        ]);
        exit;
    } else {
        echo json_encode([
            "error" => "PostNord kunde inte returnera ett pris för vikten {$weight_kg} kg och postnumret {$dest_postal_code} ({$dest_country})."
        ]);
        exit;
    }
}

// 2. Beräkna Klarnas nya totalsumma baserat på PostNords offert
$selected_shipping = $shipping_options[0];
$new_order_amount  = 0;
$new_tax_amount    = 0;

foreach ($data['order_lines'] as $line) {
    if (($line['type'] ?? '') !== 'shipping_fee') {
        $new_order_amount += (int)$line['total_amount'];
        $new_tax_amount   += (int)$line['total_tax_amount'];
    }
}

$new_order_amount += $selected_shipping['price'];
$new_tax_amount   += $selected_shipping['tax_amount'];

echo json_encode([
    "order_amount"     => $new_order_amount,
    "order_tax_amount" => $new_tax_amount,
    "shipping_options" => $shipping_options
]);
?>