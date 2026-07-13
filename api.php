<?php
// SPDX-License-Identifier: MIT
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
$allowed = ['bootstrap', 'refreshSummary', 'identify', 'listMetadataFormats', 'listSets', 'listIdentifiers', 'getRecord'];
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

if ($action === 'bootstrap') {
    if ($db === null || $nocache) {
        echo json_encode(['ok' => false, 'error' => 'No cached summary']);
        exit;
    }
    try {
        $summary = get_endpoint_summary($db, $base_url, !empty($_GET['slim']));
        if ($summary !== null) {
            echo json_encode(['ok' => true, 'data' => $summary]);
            exit;
        }
    } catch (Throwable $e) {}
    echo json_encode(['ok' => false, 'error' => 'No cached summary']);
    exit;
}

if ($action === 'refreshSummary') {
    try {
        $summary = build_endpoint_summary($base_url);
        if ($db !== null && !$nocache) {
            store_endpoint_summary($db, $base_url, $summary);
        }
        echo json_encode(['ok' => true, 'data' => $summary]);
    } catch (Throwable $e) {
        echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
    }
    exit;
}

if ($action === 'listIdentifiers' && $db !== null) {
    $page_token = parse_identifier_page_token((string)($_GET['resumptionToken'] ?? ''));
    if ($page_token) {
        $page = cached_identifier_page($db, $page_token['cache_key'], $page_token['offset']);
        if ($page !== null) {
            echo json_encode(['ok' => true, 'data' => $page]);
            exit;
        }
        echo json_encode(['ok' => false, 'error' => 'badResumptionToken: Cached result page expired', 'oai_error' => 'badResumptionToken']);
        exit;
    }

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
if ($action === 'listIdentifiers' && $db !== null && empty($_GET['resumptionToken']) && !$nocache) {
    try {
        $page = cached_identifier_page($db, $cache_key, 0);
        if ($page !== null) {
            echo json_encode(['ok' => true, 'data' => $page]);
            exit;
        }
    } catch (Throwable $e) {}
}
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
        $parsed['data']['cacheMode'] = 'live';
    } catch (Throwable $e) {}
}

if ($action === 'listIdentifiers' && $db !== null && !$nocache) {
    try {
        $parsed['data'] = cache_and_slice_identifier_page($db, $cache_key, $parsed['data'] ?? []);
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

function fetch_oai_action(string $base_url, string $action, array $params): array
{
    $raw = fetch_url(build_oai_url($base_url, $params));
    if ($raw === null) {
        return ['ok' => false, 'error' => 'Connection failed — host unreachable or timed out', 'kind' => 'unreachable'];
    }
    return parse_oai_xml($raw, $action);
}

function build_endpoint_summary(string $base_url): array
{
    $identify = fetch_oai_action($base_url, 'identify', ['verb' => 'Identify']);
    if (!$identify['ok']) {
        throw new RuntimeException((string)($identify['error'] ?? 'Identify failed'));
    }

    $formats_res = fetch_oai_action($base_url, 'listMetadataFormats', ['verb' => 'ListMetadataFormats']);
    $formats = $formats_res['ok'] ? ($formats_res['data'] ?? []) : [];
    $init_prefix = 'oai_dc';
    foreach ($formats as $format) {
        if (($format['value'] ?? '') === 'oai_dc') {
            $init_prefix = 'oai_dc';
            break;
        }
        if ($init_prefix === 'oai_dc' && !empty($format['value'])) {
            $init_prefix = (string)$format['value'];
        }
    }

    $sets_res = fetch_oai_action($base_url, 'listSets', ['verb' => 'ListSets']);
    $sets_data = $sets_res['ok'] ? ($sets_res['data'] ?? []) : [];

    $ids_res = fetch_oai_action($base_url, 'listIdentifiers', [
        'verb' => 'ListIdentifiers',
        'metadataPrefix' => $init_prefix,
    ]);
    $ids_data = $ids_res['ok'] ? ($ids_res['data'] ?? []) : [];
    $no_records_match = !$ids_res['ok'] && (($ids_res['oai_error'] ?? '') === 'noRecordsMatch');

    return [
        'identify' => $identify['data'],
        'formats' => $formats,
        'sets' => $sets_data['sets'] ?? [],
        'setsCount' => count($sets_data['sets'] ?? []),
        'setsTruncated' => !empty($sets_data['truncated']),
        'initPrefix' => $init_prefix,
        'initRecords' => [],
        'initTotal' => $ids_data['total'] ?? null,
        'initToken' => null,
        'initLoaded' => false,
        'initNoRecordsMatch' => $no_records_match,
    ];
}
