<?php
declare(strict_types=1);
ini_set('display_errors', '0');
error_reporting(0);
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/lib.php';
app_bootstrap();
set_time_limit(FETCH_TIMEOUT + 10);

$action = trim($_GET['action'] ?? '');
$allowed = ['identify', 'listMetadataFormats', 'listSets', 'listIdentifiers', 'getRecord'];
if (!in_array($action, $allowed, true)) {
    die(json_encode(['ok' => false, 'error' => 'Invalid action']));
}

$raw_url = trim($_GET['url'] ?? '');
if (!preg_match('#^https?://#i', $raw_url)) {
    die(json_encode(['ok' => false, 'error' => 'URL must start with http:// or https://']));
}
$base_url = rtrim(preg_replace('/[?#].*$/', '', $raw_url), '/');

$nocache_requested = !empty($_GET['nocache']);
$nocache = $nocache_requested && APP_ENV !== 'production';
$db = null;
try {
    $db = open_db();
} catch (Throwable $e) {
    $db = null;
}

if ($action === 'listIdentifiers' && $db !== null) {
    $local_token = parse_local_token((string)($_GET['resumptionToken'] ?? ''));
    if ($local_token) {
        $page = local_identifier_page($db, $local_token['scope_id'], $local_token['offset']);
        if ($page !== null) {
            echo json_encode(['ok' => true, 'data' => $page]);
            exit;
        }
    }

    if (empty($_GET['resumptionToken']) && !$nocache) {
        $prefix = (string)($_GET['prefix'] ?? 'oai_dc');
        $set_spec = (string)($_GET['set'] ?? '');
        $from = (string)($_GET['from'] ?? '');
        $until = (string)($_GET['until'] ?? '');
        $page = try_local_list_identifiers($db, $base_url, $prefix, $set_spec, $from, $until);
        if ($page !== null) {
            enqueue_after_list_identifiers($db, $base_url, $prefix, $set_spec, $page['total'] ?? null);
            echo json_encode(['ok' => true, 'data' => $page]);
            exit;
        }
    }
}

$params = match ($action) {
    'identify' => ['verb' => 'Identify'],
    'listMetadataFormats' => ['verb' => 'ListMetadataFormats'],
    'listSets' => ['verb' => 'ListSets'],
    'listIdentifiers' => build_list_identifier_params(),
    'getRecord' => [
        'verb' => 'GetRecord',
        'identifier' => (string)($_GET['identifier'] ?? ''),
        'metadataPrefix' => (string)($_GET['prefix'] ?? 'oai_dc'),
    ],
};
$oai_url = build_oai_url($base_url, $params);

$cacheable = $action !== 'getRecord' && $action !== 'listIdentifiers';
$cache_key = md5($oai_url);
if ($db !== null && $cacheable && !$nocache) {
    try {
        $cached = get_cached($db, $cache_key);
        if ($cached !== null) {
            echo $cached;
            exit;
        }
    } catch (Throwable $e) {}
}

$raw = fetch_url($oai_url);
if ($raw === null) {
    echo json_encode([
        'ok' => false,
        'error' => 'Connection failed — host unreachable or timed out',
        'kind' => 'unreachable',
        'oai_url' => $oai_url,
    ]);
    exit;
}

$parsed = parse_oai_xml($raw, $action);
if (!$parsed['ok']) {
    $parsed['oai_url'] = $oai_url;
    echo json_encode($parsed);
    exit;
}

if ($action === 'listIdentifiers' && $db !== null && empty($_GET['resumptionToken'])) {
    try {
        $prefix = (string)($params['metadataPrefix'] ?? 'oai_dc');
        $set_spec = (string)($params['set'] ?? '');
        enqueue_after_list_identifiers($db, $base_url, $prefix, $set_spec, $parsed['data']['total'] ?? null);
        $parsed['data']['cacheMode'] = 'live';
    } catch (Throwable $e) {}
}

$out = json_encode($parsed);
if ($db !== null && $cacheable) {
    try { store_cache($db, $cache_key, $out); } catch (Throwable $e) {}
}
echo $out;

function build_list_identifier_params(): array
{
    if (!empty($_GET['resumptionToken'])) {
        return ['verb' => 'ListIdentifiers', 'resumptionToken' => (string)$_GET['resumptionToken']];
    }

    $params = [
        'verb' => 'ListIdentifiers',
        'metadataPrefix' => (string)($_GET['prefix'] ?? 'oai_dc'),
    ];
    if (!empty($_GET['set'])) $params['set'] = (string)$_GET['set'];
    if (!empty($_GET['from'])) $params['from'] = (string)$_GET['from'];
    if (!empty($_GET['until'])) $params['until'] = (string)$_GET['until'];
    return $params;
}
