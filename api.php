<?php
declare(strict_types=1);
ini_set('display_errors', '0');
error_reporting(0);
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('X-Content-Type-Options: nosniff');

load_env_file(__DIR__ . '/.env');

define('APP_ENV',       env_string('APP_ENV', 'development')); // development|production
define('CACHE_TTL',     env_int('CACHE_TTL', 7200, 0, 604800));
define('FETCH_TIMEOUT', env_int('FETCH_TIMEOUT', 120, 1, 600));

set_time_limit(FETCH_TIMEOUT + 10);
define('OAI_NS',        'http://www.openarchives.org/OAI/2.0/');
define('DC_NS',         'http://purl.org/dc/elements/1.1/');

// ── Validate action ───────────────────────────────────────────────────────────
$action  = trim($_GET['action'] ?? '');
$allowed = ['identify', 'listMetadataFormats', 'listSets', 'listIdentifiers', 'getRecord'];
if (!in_array($action, $allowed, true)) {
    die(json_encode(['ok' => false, 'error' => 'Invalid action']));
}

// ── Validate URL ──────────────────────────────────────────────────────────────
$raw_url = trim($_GET['url'] ?? '');
if (!preg_match('#^https?://#i', $raw_url)) {
    die(json_encode(['ok' => false, 'error' => 'URL must start with http:// or https://']));
}
$base_url = rtrim(preg_replace('/[?#].*$/', '', $raw_url), '/');

// ── Build OAI-PMH request URL ─────────────────────────────────────────────────
$verb_map = [
    'identify'            => 'Identify',
    'listMetadataFormats' => 'ListMetadataFormats',
    'listSets'            => 'ListSets',
    'listIdentifiers'     => 'ListIdentifiers',
    'getRecord'           => 'GetRecord',
];
$params = ['verb' => $verb_map[$action]];

switch ($action) {
    case 'listIdentifiers':
        if (!empty($_GET['resumptionToken'])) {
            $params = ['verb' => 'ListIdentifiers', 'resumptionToken' => (string)$_GET['resumptionToken']];
        } else {
            $params['metadataPrefix'] = (string)($_GET['prefix'] ?? 'oai_dc');
            if (!empty($_GET['set']))   $params['set']   = (string)$_GET['set'];
            if (!empty($_GET['from']))  $params['from']  = (string)$_GET['from'];
            if (!empty($_GET['until'])) $params['until'] = (string)$_GET['until'];
        }
        break;
    case 'getRecord':
        $params['identifier']     = (string)($_GET['identifier'] ?? '');
        $params['metadataPrefix'] = (string)($_GET['prefix'] ?? 'oai_dc');
        break;
}
$oai_url = $base_url . '?' . http_build_query($params);

// ── Cache lookup ──────────────────────────────────────────────────────────────
$nocache_requested = !empty($_GET['nocache']);
$nocache    = $nocache_requested && APP_ENV !== 'production';
$db         = null;
$cache_key  = md5($oai_url);
try {
    $db     = open_db();
    if (!$nocache) {
        $cached = get_cached($db, $cache_key);
        if ($cached !== null) { echo $cached; exit; }
    }
} catch (Throwable $e) {
    $db = null; // proceed without cache
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
$raw = fetch_url($oai_url);
if ($raw === null) {
    $out = json_encode([
        'ok'      => false,
        'error'   => 'Connection failed — host unreachable or timed out',
        'kind'    => 'unreachable',
        'oai_url' => $oai_url,
    ]);
    echo $out;
    exit;
}

// ── Parse XML ─────────────────────────────────────────────────────────────────
libxml_use_internal_errors(true);
$dom = new DOMDocument();
if (!$dom->loadXML($raw)) {
    $out = json_encode([
        'ok'      => false,
        'error'   => 'Response is not valid XML — this URL may not be an OAI-PMH endpoint',
        'kind'    => 'not-oai',
        'oai_url' => $oai_url,
    ]);
    echo $out;
    exit;
}

$xp = new DOMXPath($dom);
// Some endpoints (e.g. GDZ Göttingen) declare xmlns="https://..." instead of
// the canonical "http://..." namespace. Detect what the document actually uses.
$actual_oai_ns = $dom->documentElement?->namespaceURI ?: OAI_NS;
$xp->registerNamespace('oai',    $actual_oai_ns);
$xp->registerNamespace('dc',     DC_NS);
$xp->registerNamespace('oai_dc', 'http://www.openarchives.org/OAI/2.0/oai_dc/');

// OAI-PMH error element
$err_nodes = $xp->query('//oai:error');
if ($err_nodes && $err_nodes->length > 0) {
    $err  = $err_nodes->item(0);
    $code = $err->getAttribute('code');
    $msg  = trim($err->textContent);
    $out  = json_encode(['ok' => false, 'error' => "$code: $msg", 'oai_error' => $code]);
    echo $out;
    exit;
}

// Parse and return
try {
    $data = parse_response($xp, $action);
    $out  = json_encode(['ok' => true, 'data' => $data]);
} catch (Throwable $e) {
    $out = json_encode(['ok' => false, 'error' => $e->getMessage()]);
}

if ($db !== null) {
    try { store_cache($db, $cache_key, $out); } catch (Throwable $e) {}
}
echo $out;

// ═════════════════════════════════════════════════════════════════════════════
// Functions
// ═════════════════════════════════════════════════════════════════════════════

function fetch_url(string $url): ?string
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => FETCH_TIMEOUT,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 5,
            CURLOPT_USERAGENT      => 'OAI-PMH-Explorer/0.4',
            CURLOPT_HTTPHEADER     => ['Accept: application/xml, text/xml'],
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $body = curl_exec($ch);
        curl_close($ch);
        if ($body !== false && strlen((string)$body) > 0) {
            return (string)$body;
        }
        return null;
    }
    // Fallback to file_get_contents
    $ctx  = stream_context_create(['http' => [
        'timeout'    => FETCH_TIMEOUT,
        'user_agent' => 'OAI-PMH-Explorer/0.4',
        'header'     => "Accept: application/xml, text/xml\r\n",
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    return $body !== false ? $body : null;
}

function parse_response(DOMXPath $xp, string $action): array
{
    return match ($action) {
        'identify'            => parse_identify($xp),
        'listMetadataFormats' => parse_formats($xp),
        'listSets'            => parse_sets($xp),
        'listIdentifiers'     => parse_identifiers($xp),
        'getRecord'           => parse_record($xp),
        default               => [],
    };
}

function parse_identify(DOMXPath $xp): array
{
    $fields = [
        'repositoryName', 'baseURL', 'protocolVersion', 'adminEmail',
        'earliestDatestamp', 'deletedRecord', 'granularity', 'compression',
    ];
    $out = [];
    foreach ($fields as $f) {
        $nodes = $xp->query("//oai:Identify/oai:$f");
        $out[$f] = ($nodes && $nodes->length > 0) ? trim($nodes->item(0)->textContent) : '';
    }
    return $out;
}

function parse_formats(DOMXPath $xp): array
{
    $out   = [];
    $nodes = $xp->query('//oai:metadataFormat');
    foreach ($nodes as $n) {
        $prefix = xp_text($xp, 'oai:metadataPrefix', $n);
        $out[]  = [
            'value'     => $prefix,
            'label'     => $prefix,
            'schema'    => xp_text($xp, 'oai:schema',            $n),
            'namespace' => xp_text($xp, 'oai:metadataNamespace', $n),
        ];
    }
    return $out;
}

function parse_sets(DOMXPath $xp): array
{
    $sets  = [];
    $nodes = $xp->query('//oai:set');
    foreach ($nodes as $n) {
        $sets[] = [
            'spec' => xp_text($xp, 'oai:setSpec', $n),
            'name' => xp_text($xp, 'oai:setName', $n),
        ];
    }
    $tok_nodes = $xp->query('//oai:resumptionToken');
    $truncated = ($tok_nodes && $tok_nodes->length > 0
                  && trim($tok_nodes->item(0)->textContent) !== '');
    return ['sets' => $sets, 'truncated' => $truncated];
}

function parse_identifiers(DOMXPath $xp): array
{
    $ids     = [];
    $headers = $xp->query('//oai:header');
    foreach ($headers as $h) {
        $ids[] = [
            'identifier' => xp_text($xp, 'oai:identifier', $h),
            'datestamp'  => xp_text($xp, 'oai:datestamp',  $h),
            'deleted'    => $h->getAttribute('status') === 'deleted',
        ];
    }
    $total    = null;
    $resToken = null;
    $tok_nodes = $xp->query('//oai:resumptionToken');
    if ($tok_nodes && $tok_nodes->length > 0) {
        $tok = $tok_nodes->item(0);
        $cls = $tok->getAttribute('completeListSize');
        if ($cls !== '') $total = (int)$cls;
        $t = trim($tok->textContent);
        if ($t !== '') $resToken = $t;
    }
    return [
        'identifiers'     => $ids,
        'total'           => $total,
        'resumptionToken' => $resToken,
    ];
}

function parse_record(DOMXPath $xp): array
{
    $identifier = trim($xp->query('//oai:header/oai:identifier')->item(0)?->textContent ?? '');
    $datestamp  = trim($xp->query('//oai:header/oai:datestamp')->item(0)?->textContent ?? '');
    $hdr_nodes  = $xp->query('//oai:header');
    $deleted    = ($hdr_nodes->length > 0 && $hdr_nodes->item(0)->getAttribute('status') === 'deleted');

    $set_specs = [];
    foreach ($xp->query('//oai:header/oai:setSpec') as $ss) {
        $set_specs[] = trim($ss->textContent);
    }

    // Raw XML of the <record> element, pretty-printed
    $rec_nodes = $xp->query('//oai:record');
    $raw_xml   = '';
    if ($rec_nodes && $rec_nodes->length > 0) {
        $out_dom = new DOMDocument('1.0', 'UTF-8');
        $out_dom->formatOutput = true;
        $node = $out_dom->importNode($rec_nodes->item(0), true);
        $out_dom->appendChild($node);
        $raw_xml = $out_dom->saveXML($out_dom->documentElement);
    }

    // Dublin Core fields
    $dc_fields = [
        'title', 'creator', 'subject', 'description', 'publisher', 'contributor',
        'date', 'type', 'format', 'identifier', 'source', 'language', 'relation',
        'coverage', 'rights',
    ];
    $dc = [];
    foreach ($dc_fields as $f) {
        $nodes = $xp->query("//dc:$f");
        if ($nodes && $nodes->length > 0) {
            $vals = [];
            foreach ($nodes as $n) $vals[] = trim($n->textContent);
            $dc[$f] = $vals;
        }
    }

    return [
        'identifier' => $identifier,
        'datestamp'  => $datestamp,
        'deleted'    => $deleted,
        'setSpecs'   => $set_specs,
        'xml'        => $raw_xml,
        'dc'         => $dc,
    ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function xp_text(DOMXPath $xp, string $query, ?DOMNode $ctx = null): string
{
    $nodes = $ctx ? $xp->query($query, $ctx) : $xp->query($query);
    return ($nodes && $nodes->length > 0) ? trim($nodes->item(0)->textContent) : '';
}

function open_db(): PDO
{
    $path = __DIR__ . '/cache.sqlite';
    $db   = new PDO("sqlite:$path");
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec("CREATE TABLE IF NOT EXISTS cache (
        key        TEXT PRIMARY KEY,
        response   TEXT    NOT NULL,
        fetched_at INTEGER NOT NULL
    )");
    return $db;
}

function get_cached(PDO $db, string $key): ?string
{
    $stmt = $db->prepare('SELECT response, fetched_at FROM cache WHERE key = ?');
    $stmt->execute([$key]);
    $row  = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row && (time() - (int)$row['fetched_at']) < CACHE_TTL) {
        return $row['response'];
    }
    return null;
}

function store_cache(PDO $db, string $key, string $data): void
{
    $db->prepare('INSERT OR REPLACE INTO cache (key, response, fetched_at) VALUES (?, ?, ?)')
       ->execute([$key, $data, time()]);
}

function load_env_file(string $path): void
{
    if (!is_file($path) || !is_readable($path)) return;

    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) return;

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) continue;
        $eq = strpos($line, '=');
        if ($eq === false) continue;

        $key = trim(substr($line, 0, $eq));
        $val = trim(substr($line, $eq + 1));
        if ($key === '') continue;

        if (
            (str_starts_with($val, '"') && str_ends_with($val, '"')) ||
            (str_starts_with($val, "'") && str_ends_with($val, "'"))
        ) {
            $val = substr($val, 1, -1);
        }

        putenv("{$key}={$val}");
        $_ENV[$key] = $val;
        $_SERVER[$key] = $val;
    }
}

function env_string(string $key, string $default): string
{
    $val = getenv($key);
    if ($val === false || $val === '') return $default;
    return (string)$val;
}

function env_int(string $key, int $default, int $min, int $max): int
{
    $raw = getenv($key);
    if ($raw === false || $raw === '') return $default;
    if (!preg_match('/^-?\d+$/', (string)$raw)) return $default;

    $n = (int)$raw;
    if ($n < $min) return $min;
    if ($n > $max) return $max;
    return $n;
}
