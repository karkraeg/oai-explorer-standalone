<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

define('OAI_NS', 'http://www.openarchives.org/OAI/2.0/');
define('DC_NS', 'http://purl.org/dc/elements/1.1/');
define('APP_VERSION', '3.0.4');

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
    return ($val === false || $val === '') ? $default : (string)$val;
}

function env_int(string $key, int $default, int $min, int $max): int
{
    $val = getenv($key);
    if ($val === false || $val === '' || !is_numeric($val)) return $default;
    return max($min, min($max, (int)$val));
}

function app_bootstrap(): void
{
    load_env_file(__DIR__ . '/.env');
    if (!defined('APP_ENV')) {
        define('APP_ENV', env_string('APP_ENV', 'development'));
        define('CACHE_TTL', env_int('CACHE_TTL', 7200, 0, 604800));
        define('FETCH_TIMEOUT', env_int('FETCH_TIMEOUT', 120, 1, 600));
        define('OAI_USER_AGENT', env_string('OAI_USER_AGENT', 'OAI-PMH-Explorer/' . APP_VERSION));
        define('HARVEST_DELAY_MS', env_int('HARVEST_DELAY_MS', 1000, 0, 60000));
        define('HARVEST_PAGE_SIZE', env_int('HARVEST_PAGE_SIZE', 100, 10, 1000));
        define('HARVEST_MAX_SCOPE_ENTRIES', env_int('HARVEST_MAX_SCOPE_ENTRIES', 1000000, 100, 50000000));
        define('HARVEST_MAX_INACTIVE_DAYS', env_int('HARVEST_MAX_INACTIVE_DAYS', 90, 1, 3650));
    }
}

function open_db(): PDO
{
    $dsn = env_string('DATABASE_URL', '');
    if ($dsn === '') {
        $db = new PDO('sqlite:' . __DIR__ . '/cache.sqlite');
    } else {
        $db = new PDO($dsn, env_string('DATABASE_USER', ''), env_string('DATABASE_PASSWORD', ''));
    }
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    migrate_db($db);
    return $db;
}

function db_driver(PDO $db): string
{
    return (string)$db->getAttribute(PDO::ATTR_DRIVER_NAME);
}

function migrate_db(PDO $db): void
{
    if (db_driver($db) === 'pgsql') {
        $db->exec("
            CREATE TABLE IF NOT EXISTS response_cache (
                cache_key TEXT PRIMARY KEY,
                response TEXT NOT NULL,
                fetched_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS endpoint_summaries (
                base_url TEXT PRIMARY KEY,
                summary_json TEXT NOT NULL,
                refreshed_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS harvest_scopes (
                id BIGSERIAL PRIMARY KEY,
                base_url TEXT NOT NULL,
                metadata_prefix TEXT NOT NULL,
                set_spec TEXT NOT NULL DEFAULT '',
                granularity TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'new',
                last_datestamp TEXT NOT NULL DEFAULT '',
                last_full_harvest_at INTEGER,
                last_delta_harvest_at INTEGER,
                last_accessed_at INTEGER NOT NULL,
                expected_total INTEGER,
                entry_count INTEGER NOT NULL DEFAULT 0,
                UNIQUE (base_url, metadata_prefix, set_spec)
            );
            CREATE TABLE IF NOT EXISTS harvest_entries (
                id BIGSERIAL PRIMARY KEY,
                scope_id BIGINT NOT NULL REFERENCES harvest_scopes(id) ON DELETE CASCADE,
                identifier TEXT NOT NULL,
                datestamp TEXT NOT NULL,
                deleted BOOLEAN NOT NULL DEFAULT FALSE,
                set_specs_json TEXT NOT NULL DEFAULT '[]',
                seen_at INTEGER NOT NULL,
                UNIQUE (scope_id, identifier)
            );
            CREATE TABLE IF NOT EXISTS harvest_jobs (
                id BIGSERIAL PRIMARY KEY,
                scope_id BIGINT NOT NULL REFERENCES harvest_scopes(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                resumption_token TEXT,
                pages_done INTEGER NOT NULL DEFAULT 0,
                entries_seen INTEGER NOT NULL DEFAULT 0,
                started_at INTEGER,
                finished_at INTEGER,
                error TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_entries_scope_datestamp ON harvest_entries(scope_id, datestamp DESC, identifier);
            CREATE INDEX IF NOT EXISTS idx_entries_scope_deleted ON harvest_entries(scope_id, deleted);
            CREATE INDEX IF NOT EXISTS idx_scopes_accessed ON harvest_scopes(last_accessed_at);
            CREATE INDEX IF NOT EXISTS idx_jobs_status ON harvest_jobs(status, created_at);
            ALTER TABLE harvest_scopes ADD COLUMN IF NOT EXISTS expected_total INTEGER;
        ");
        return;
    }

    $db->exec("
        CREATE TABLE IF NOT EXISTS response_cache (
            cache_key TEXT PRIMARY KEY,
            response TEXT NOT NULL,
            fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS endpoint_summaries (
            base_url TEXT PRIMARY KEY,
            summary_json TEXT NOT NULL,
            refreshed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS harvest_scopes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            base_url TEXT NOT NULL,
            metadata_prefix TEXT NOT NULL,
            set_spec TEXT NOT NULL DEFAULT '',
            granularity TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'new',
            last_datestamp TEXT NOT NULL DEFAULT '',
                last_full_harvest_at INTEGER,
                last_delta_harvest_at INTEGER,
                last_accessed_at INTEGER NOT NULL,
                expected_total INTEGER,
                entry_count INTEGER NOT NULL DEFAULT 0,
                UNIQUE (base_url, metadata_prefix, set_spec)
            );
        CREATE TABLE IF NOT EXISTS harvest_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_id INTEGER NOT NULL REFERENCES harvest_scopes(id) ON DELETE CASCADE,
            identifier TEXT NOT NULL,
            datestamp TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            set_specs_json TEXT NOT NULL DEFAULT '[]',
            seen_at INTEGER NOT NULL,
            UNIQUE (scope_id, identifier)
        );
        CREATE TABLE IF NOT EXISTS harvest_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_id INTEGER NOT NULL REFERENCES harvest_scopes(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            resumption_token TEXT,
            pages_done INTEGER NOT NULL DEFAULT 0,
            entries_seen INTEGER NOT NULL DEFAULT 0,
            started_at INTEGER,
            finished_at INTEGER,
            error TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_entries_scope_datestamp ON harvest_entries(scope_id, datestamp DESC, identifier);
        CREATE INDEX IF NOT EXISTS idx_entries_scope_deleted ON harvest_entries(scope_id, deleted);
        CREATE INDEX IF NOT EXISTS idx_scopes_accessed ON harvest_scopes(last_accessed_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON harvest_jobs(status, created_at);
    ");
    ensure_sqlite_column($db, 'harvest_scopes', 'expected_total', 'INTEGER');
}

function ensure_sqlite_column(PDO $db, string $table, string $column, string $definition): void
{
    if (db_driver($db) !== 'sqlite') return;
    $stmt = $db->query("PRAGMA table_info({$table})");
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        if (($row['name'] ?? '') === $column) return;
    }
    $db->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$definition}");
}

function get_cached(PDO $db, string $key): ?string
{
    $stmt = $db->prepare('SELECT response, fetched_at FROM response_cache WHERE cache_key = ?');
    $stmt->execute([$key]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row && (time() - (int)$row['fetched_at']) < CACHE_TTL) {
        return (string)$row['response'];
    }
    return null;
}

function store_cache(PDO $db, string $key, string $data): void
{
    $stmt = $db->prepare('INSERT INTO response_cache (cache_key, response, fetched_at) VALUES (?, ?, ?)
        ON CONFLICT (cache_key) DO UPDATE SET response = excluded.response, fetched_at = excluded.fetched_at');
    $stmt->execute([$key, $data, time()]);
}

function get_endpoint_summary(PDO $db, string $base_url, bool $slim = false): ?array
{
    $stmt = $db->prepare('SELECT summary_json, refreshed_at FROM endpoint_summaries WHERE base_url = ?');
    $stmt->execute([$base_url]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;

    $summary = json_decode((string)$row['summary_json'], true);
    if (!is_array($summary)) return null;

    $refreshed_at = (int)$row['refreshed_at'];
    $summary['refreshedAt'] = $refreshed_at;
    $summary['stale'] = (time() - $refreshed_at) >= CACHE_TTL;
    if (!isset($summary['setsCount']) && is_array($summary['sets'] ?? null)) {
        $summary['setsCount'] = count($summary['sets']);
    }
    if ($slim && is_array($summary['sets'] ?? null) && count($summary['sets']) > 200) {
        $summary['sets'] = [];
        $summary['setsHydrated'] = false;
    }
    return $summary;
}

function store_endpoint_summary(PDO $db, string $base_url, array $summary): void
{
    $now = time();
    if (!isset($summary['setsCount']) && is_array($summary['sets'] ?? null)) {
        $summary['setsCount'] = count($summary['sets']);
    }
    $summary['setsHydrated'] = true;
    $summary['refreshedAt'] = $now;
    $summary['stale'] = false;
    $stmt = $db->prepare('INSERT INTO endpoint_summaries (base_url, summary_json, refreshed_at) VALUES (?, ?, ?)
        ON CONFLICT (base_url) DO UPDATE SET summary_json = excluded.summary_json, refreshed_at = excluded.refreshed_at');
    $stmt->execute([$base_url, json_encode($summary, JSON_UNESCAPED_SLASHES), $now]);
}

function build_oai_url(string $base_url, array $params): string
{
    return $base_url . '?' . http_build_query($params);
}

function fetch_url(string $url): ?string
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => FETCH_TIMEOUT,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 5,
            CURLOPT_USERAGENT => OAI_USER_AGENT,
            CURLOPT_HTTPHEADER => ['Accept: application/xml, text/xml'],
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $body = curl_exec($ch);
        curl_close($ch);
        return ($body !== false && strlen((string)$body) > 0) ? (string)$body : null;
    }

    $ctx = stream_context_create(['http' => [
        'timeout' => FETCH_TIMEOUT,
        'user_agent' => OAI_USER_AGENT,
        'header' => "Accept: application/xml, text/xml\r\n",
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    return $body !== false ? $body : null;
}

function parse_oai_xml(string $raw, string $action): array
{
    libxml_use_internal_errors(true);
    $dom = new DOMDocument();
    if (!$dom->loadXML($raw)) {
        return ['ok' => false, 'error' => 'Response is not valid XML — this URL may not be an OAI-PMH endpoint', 'kind' => 'not-oai'];
    }

    $xp = new DOMXPath($dom);
    $actual_oai_ns = $dom->documentElement?->namespaceURI ?: OAI_NS;
    $xp->registerNamespace('oai', $actual_oai_ns);
    $xp->registerNamespace('dc', DC_NS);
    $xp->registerNamespace('oai_dc', 'http://www.openarchives.org/OAI/2.0/oai_dc/');

    $err_nodes = $xp->query('//oai:error');
    if ($err_nodes && $err_nodes->length > 0) {
        $err = $err_nodes->item(0);
        $code = $err->getAttribute('code');
        $msg = trim($err->textContent);
        return ['ok' => false, 'error' => "$code: $msg", 'oai_error' => $code];
    }

    try {
        return ['ok' => true, 'data' => parse_response($xp, $action)];
    } catch (Throwable $e) {
        return ['ok' => false, 'error' => $e->getMessage()];
    }
}

function parse_response(DOMXPath $xp, string $action): array
{
    return match ($action) {
        'identify' => parse_identify($xp),
        'listMetadataFormats' => parse_formats($xp),
        'listSets' => parse_sets($xp),
        'listIdentifiers' => parse_identifiers($xp),
        'getRecord' => parse_record($xp),
        default => [],
    };
}

function parse_identify(DOMXPath $xp): array
{
    $fields = ['repositoryName', 'baseURL', 'protocolVersion', 'adminEmail', 'earliestDatestamp', 'deletedRecord', 'granularity', 'compression'];
    $out = [];
    foreach ($fields as $f) {
        $nodes = $xp->query("//oai:Identify/oai:$f");
        $out[$f] = ($nodes && $nodes->length > 0) ? trim($nodes->item(0)->textContent) : '';
    }
    return $out;
}

function parse_formats(DOMXPath $xp): array
{
    $out = [];
    foreach ($xp->query('//oai:metadataFormat') as $n) {
        $prefix = xp_text($xp, 'oai:metadataPrefix', $n);
        $out[] = [
            'value' => $prefix,
            'label' => $prefix,
            'schema' => xp_text($xp, 'oai:schema', $n),
            'namespace' => xp_text($xp, 'oai:metadataNamespace', $n),
        ];
    }
    return $out;
}

function parse_sets(DOMXPath $xp): array
{
    $sets = [];
    foreach ($xp->query('//oai:set') as $n) {
        $sets[] = ['spec' => xp_text($xp, 'oai:setSpec', $n), 'name' => xp_text($xp, 'oai:setName', $n)];
    }
    $tok_nodes = $xp->query('//oai:resumptionToken');
    $truncated = ($tok_nodes && $tok_nodes->length > 0 && trim($tok_nodes->item(0)->textContent) !== '');
    return ['sets' => $sets, 'truncated' => $truncated];
}

function parse_identifiers(DOMXPath $xp): array
{
    $ids = [];
    foreach ($xp->query('//oai:header') as $h) {
        $set_specs = [];
        foreach ($xp->query('oai:setSpec', $h) as $ss) {
            $set_specs[] = trim($ss->textContent);
        }
        $ids[] = [
            'identifier' => xp_text($xp, 'oai:identifier', $h),
            'datestamp' => xp_text($xp, 'oai:datestamp', $h),
            'deleted' => $h->getAttribute('status') === 'deleted',
            'setSpecs' => $set_specs,
        ];
    }
    $total = null;
    $resToken = null;
    $tok_nodes = $xp->query('//oai:resumptionToken');
    if ($tok_nodes && $tok_nodes->length > 0) {
        $tok = $tok_nodes->item(0);
        $cls = $tok->getAttribute('completeListSize');
        if ($cls !== '') $total = (int)$cls;
        $t = trim($tok->textContent);
        if ($t !== '') $resToken = $t;
    }
    return ['identifiers' => $ids, 'total' => $total, 'resumptionToken' => $resToken];
}

function parse_record(DOMXPath $xp): array
{
    $identifier = trim($xp->query('//oai:header/oai:identifier')->item(0)?->textContent ?? '');
    $datestamp = trim($xp->query('//oai:header/oai:datestamp')->item(0)?->textContent ?? '');
    $hdr_nodes = $xp->query('//oai:header');
    $deleted = ($hdr_nodes->length > 0 && $hdr_nodes->item(0)->getAttribute('status') === 'deleted');

    $set_specs = [];
    foreach ($xp->query('//oai:header/oai:setSpec') as $ss) {
        $set_specs[] = trim($ss->textContent);
    }

    $rec_nodes = $xp->query('//oai:record');
    $raw_xml = '';
    if ($rec_nodes && $rec_nodes->length > 0) {
        $tmp = new DOMDocument();
        $tmp->appendChild($tmp->importNode($rec_nodes->item(0), true));
        $out_dom = new DOMDocument('1.0', 'UTF-8');
        $out_dom->preserveWhiteSpace = false;
        $out_dom->formatOutput = true;
        $out_dom->loadXML($tmp->saveXML($tmp->documentElement));
        $raw_xml = $out_dom->saveXML($out_dom->documentElement);
    }

    $dc_fields = ['title', 'creator', 'subject', 'description', 'publisher', 'contributor', 'date', 'type', 'format', 'identifier', 'source', 'language', 'relation', 'coverage', 'rights'];
    $dc = [];
    foreach ($dc_fields as $f) {
        $nodes = $xp->query("//dc:$f");
        if ($nodes && $nodes->length > 0) {
            $vals = [];
            foreach ($nodes as $n) $vals[] = trim($n->textContent);
            $dc[$f] = $vals;
        }
    }

    return ['identifier' => $identifier, 'datestamp' => $datestamp, 'deleted' => $deleted, 'setSpecs' => $set_specs, 'xml' => $raw_xml, 'dc' => $dc];
}

function xp_text(DOMXPath $xp, string $query, ?DOMNode $ctx = null): string
{
    $nodes = $ctx ? $xp->query($query, $ctx) : $xp->query($query);
    return ($nodes && $nodes->length > 0) ? trim($nodes->item(0)->textContent) : '';
}

function get_or_create_scope(PDO $db, string $base_url, string $prefix, string $set_spec): int
{
    $now = time();
    $stmt = $db->prepare('INSERT INTO harvest_scopes (base_url, metadata_prefix, set_spec, last_accessed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (base_url, metadata_prefix, set_spec) DO UPDATE SET last_accessed_at = excluded.last_accessed_at');
    $stmt->execute([$base_url, $prefix, $set_spec, $now]);

    $stmt = $db->prepare('SELECT id FROM harvest_scopes WHERE base_url = ? AND metadata_prefix = ? AND set_spec = ?');
    $stmt->execute([$base_url, $prefix, $set_spec]);
    return (int)$stmt->fetchColumn();
}

function get_scope(PDO $db, int $scope_id): ?array
{
    $stmt = $db->prepare('SELECT * FROM harvest_scopes WHERE id = ?');
    $stmt->execute([$scope_id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function find_scope(PDO $db, string $base_url, string $prefix, string $set_spec): ?array
{
    $stmt = $db->prepare('SELECT * FROM harvest_scopes WHERE base_url = ? AND metadata_prefix = ? AND set_spec = ?');
    $stmt->execute([$base_url, $prefix, $set_spec]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function enqueue_harvest(PDO $db, int $scope_id, string $type): void
{
    $stmt = $db->prepare("SELECT COUNT(*) FROM harvest_jobs WHERE scope_id = ? AND type = ? AND status IN ('queued', 'running')");
    $stmt->execute([$scope_id, $type]);
    if ((int)$stmt->fetchColumn() > 0) return;

    $stmt = $db->prepare('INSERT INTO harvest_jobs (scope_id, type, status, created_at) VALUES (?, ?, ?, ?)');
    $stmt->execute([$scope_id, $type, 'queued', time()]);
}

function enqueue_after_list_identifiers(PDO $db, string $base_url, string $prefix, string $set_spec, ?int $expected_total = null): void
{
    $scope_id = get_or_create_scope($db, $base_url, $prefix, $set_spec);
    if ($expected_total !== null) {
        $db->prepare('UPDATE harvest_scopes SET expected_total = ? WHERE id = ?')->execute([$expected_total, $scope_id]);
    }
    $scope = get_scope($db, $scope_id);
    if (!$scope) return;

    if (($scope['status'] ?? '') !== 'complete') {
        enqueue_harvest($db, $scope_id, 'full');
        return;
    }

    $last = (int)($scope['last_delta_harvest_at'] ?: $scope['last_full_harvest_at'] ?: 0);
    if ($last > 0 && (time() - $last) > CACHE_TTL) {
        enqueue_harvest($db, $scope_id, 'delta');
    }
}

function local_token(int $scope_id, int $offset): string
{
    return 'local:' . base64_encode(json_encode(['scope_id' => $scope_id, 'offset' => $offset], JSON_UNESCAPED_SLASHES));
}

function parse_local_token(string $token): ?array
{
    if (!str_starts_with($token, 'local:')) return null;
    $json = base64_decode(substr($token, 6), true);
    if ($json === false) return null;
    $data = json_decode($json, true);
    if (!is_array($data) || empty($data['scope_id'])) return null;
    return ['scope_id' => (int)$data['scope_id'], 'offset' => max(0, (int)($data['offset'] ?? 0))];
}

function identifier_page_token(string $cache_key, int $offset): string
{
    return 'page:' . base64_encode(json_encode(['cache_key' => $cache_key, 'offset' => $offset], JSON_UNESCAPED_SLASHES));
}

function parse_identifier_page_token(string $token): ?array
{
    if (!str_starts_with($token, 'page:')) return null;
    $json = base64_decode(substr($token, 5), true);
    if ($json === false) return null;
    $data = json_decode($json, true);
    if (!is_array($data) || empty($data['cache_key'])) return null;
    return ['cache_key' => (string)$data['cache_key'], 'offset' => max(0, (int)($data['offset'] ?? 0))];
}

function identifier_page_cache_key(string $key): string
{
    return 'identifier-page:' . $key;
}

function cache_and_slice_identifier_page(PDO $db, string $cache_key, array $data): array
{
    $identifiers = $data['identifiers'] ?? [];
    if (!is_array($identifiers) || (count($identifiers) <= HARVEST_PAGE_SIZE && empty($data['resumptionToken']))) {
        return $data;
    }

    $payload = [
        'identifiers' => $identifiers,
        'total' => $data['total'] ?? null,
        'remoteToken' => $data['resumptionToken'] ?? null,
    ];
    store_cache($db, identifier_page_cache_key($cache_key), json_encode($payload, JSON_UNESCAPED_SLASHES));
    return slice_cached_identifier_page($payload, $cache_key, 0);
}

function cached_identifier_page(PDO $db, string $cache_key, int $offset): ?array
{
    $json = get_cached($db, identifier_page_cache_key($cache_key));
    if ($json === null) return null;
    $payload = json_decode($json, true);
    if (!is_array($payload)) return null;
    return slice_cached_identifier_page($payload, $cache_key, $offset);
}

function slice_cached_identifier_page(array $payload, string $cache_key, int $offset): array
{
    $identifiers = is_array($payload['identifiers'] ?? null) ? $payload['identifiers'] : [];
    $limit = HARVEST_PAGE_SIZE;
    $slice = array_slice($identifiers, $offset, $limit);
    $next_offset = $offset + $limit;
    $next = ($next_offset < count($identifiers))
        ? identifier_page_token($cache_key, $next_offset)
        : ($payload['remoteToken'] ?? null);

    return [
        'identifiers' => $slice,
        'total' => $payload['total'] ?? null,
        'resumptionToken' => $next,
        'cacheMode' => 'page-cache',
    ];
}

function local_identifier_page(PDO $db, int $scope_id, int $offset = 0): ?array
{
    $scope = get_scope($db, $scope_id);
    if (!$scope || ($scope['status'] ?? '') !== 'complete') return null;
    $expected_total = $scope['expected_total'] ?? null;
    if ($expected_total !== null && $expected_total !== '' && (int)$scope['entry_count'] < (int)$expected_total) {
        return null;
    }

    $limit = HARVEST_PAGE_SIZE;
    $stmt = $db->prepare('SELECT identifier, datestamp, deleted FROM harvest_entries WHERE scope_id = ? ORDER BY datestamp DESC, identifier LIMIT ? OFFSET ?');
    $stmt->bindValue(1, $scope_id, PDO::PARAM_INT);
    $stmt->bindValue(2, $limit, PDO::PARAM_INT);
    $stmt->bindValue(3, $offset, PDO::PARAM_INT);
    $stmt->execute();

    $ids = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $ids[] = ['identifier' => $row['identifier'], 'datestamp' => $row['datestamp'], 'deleted' => db_bool($row['deleted'])];
    }
    $total = (int)$scope['entry_count'];
    $next = ($offset + $limit < $total) ? local_token($scope_id, $offset + $limit) : null;
    return ['identifiers' => $ids, 'total' => $total, 'resumptionToken' => $next, 'cacheMode' => 'local'];
}

function try_local_list_identifiers(PDO $db, string $base_url, string $prefix, string $set_spec, string $from, string $until): ?array
{
    if ($from !== '' || $until !== '') return null;
    $scope = find_scope($db, $base_url, $prefix, $set_spec);
    if (!$scope || ($scope['status'] ?? '') !== 'complete') return null;
    return local_identifier_page($db, (int)$scope['id'], 0);
}

function upsert_harvest_entries(PDO $db, int $scope_id, array $identifiers): void
{
    $now = time();
    $is_pgsql = db_driver($db) === 'pgsql';
    $stmt = $db->prepare('INSERT INTO harvest_entries (scope_id, identifier, datestamp, deleted, set_specs_json, seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (scope_id, identifier) DO UPDATE SET
            datestamp = excluded.datestamp,
            deleted = excluded.deleted,
            set_specs_json = excluded.set_specs_json,
            seen_at = excluded.seen_at');
    foreach ($identifiers as $id) {
        if (empty($id['identifier'])) continue;
        $stmt->bindValue(1, $scope_id, PDO::PARAM_INT);
        $stmt->bindValue(2, (string)$id['identifier']);
        $stmt->bindValue(3, (string)($id['datestamp'] ?? ''));
        $stmt->bindValue(4, !empty($id['deleted']) ? ($is_pgsql ? 'true' : 1) : ($is_pgsql ? 'false' : 0));
        $stmt->bindValue(5, json_encode($id['setSpecs'] ?? [], JSON_UNESCAPED_SLASHES));
        $stmt->bindValue(6, $now, PDO::PARAM_INT);
        $stmt->execute();
    }
}

function refresh_scope_stats(PDO $db, int $scope_id): void
{
    $stmt = $db->prepare('SELECT COUNT(*), COALESCE(MAX(datestamp), \'\') FROM harvest_entries WHERE scope_id = ?');
    $stmt->execute([$scope_id]);
    $row = $stmt->fetch(PDO::FETCH_NUM);
    $db->prepare('UPDATE harvest_scopes SET entry_count = ?, last_datestamp = ? WHERE id = ?')
       ->execute([(int)$row[0], (string)$row[1], $scope_id]);
}

function next_harvest_job(PDO $db): ?array
{
    $stmt = $db->query("SELECT * FROM harvest_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1");
    $job = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$job) return null;

    $db->prepare("UPDATE harvest_jobs SET status = 'running', started_at = ? WHERE id = ?")
       ->execute([time(), (int)$job['id']]);
    $job['status'] = 'running';
    return $job;
}

function process_harvest_job(PDO $db, array $job): void
{
    $scope = get_scope($db, (int)$job['scope_id']);
    if (!$scope) throw new RuntimeException('Harvest scope missing');

    $db->prepare("UPDATE harvest_scopes SET status = 'harvesting' WHERE id = ?")->execute([(int)$scope['id']]);
    $base_url = (string)$scope['base_url'];
    $prefix = (string)$scope['metadata_prefix'];
    $set_spec = (string)$scope['set_spec'];
    $token = $job['resumption_token'] ?: null;

    while (true) {
        $params = ['verb' => 'ListIdentifiers'];
        if ($token) {
            $params['resumptionToken'] = $token;
        } else {
            $params['metadataPrefix'] = $prefix;
            if ($set_spec !== '') $params['set'] = $set_spec;
            if ($job['type'] === 'delta' && !empty($scope['last_datestamp'])) {
                $params['from'] = (string)$scope['last_datestamp'];
            }
        }

        $raw = fetch_url(build_oai_url($base_url, $params));
        if ($raw === null) throw new RuntimeException('Connection failed during harvest');

        $parsed = parse_oai_xml($raw, 'listIdentifiers');
        if (!$parsed['ok']) {
            if (($parsed['oai_error'] ?? '') === 'noRecordsMatch' && $job['type'] === 'delta') {
                complete_harvest_job($db, (int)$job['id'], (int)$scope['id'], (string)$job['type']);
                return;
            }
            throw new RuntimeException((string)($parsed['error'] ?? 'Harvest parse failed'));
        }

        $data = $parsed['data'];
        $ids = $data['identifiers'] ?? [];
        $total = $data['total'] ?? null;
        upsert_harvest_entries($db, (int)$scope['id'], $ids);
        refresh_scope_stats($db, (int)$scope['id']);

        $pages = (int)$job['pages_done'] + 1;
        $seen = (int)$job['entries_seen'] + count($ids);
        if ($seen > HARVEST_MAX_SCOPE_ENTRIES) {
            throw new RuntimeException('Scope entry limit exceeded');
        }

        $token = $data['resumptionToken'] ?? null;
        $db->prepare('UPDATE harvest_jobs SET resumption_token = ?, pages_done = ?, entries_seen = ? WHERE id = ?')
           ->execute([$token, $pages, $seen, (int)$job['id']]);
        $job['pages_done'] = $pages;
        $job['entries_seen'] = $seen;

        if (!$token) {
            $expected_total = $total ?? ($scope['expected_total'] ?? null);
            if ($job['type'] === 'full' && $expected_total !== null && $expected_total !== '' && $seen < (int)$expected_total) {
                throw new RuntimeException("Harvest ended early after {$seen} of {$expected_total} reported identifiers");
            }
            complete_harvest_job($db, (int)$job['id'], (int)$scope['id'], (string)$job['type']);
            return;
        }

        if (HARVEST_DELAY_MS > 0) usleep(HARVEST_DELAY_MS * 1000);
    }
}

function complete_harvest_job(PDO $db, int $job_id, int $scope_id, string $type): void
{
    refresh_scope_stats($db, $scope_id);
    $field = $type === 'delta' ? 'last_delta_harvest_at' : 'last_full_harvest_at';
    $db->prepare("UPDATE harvest_scopes SET status = 'complete', {$field} = ? WHERE id = ?")->execute([time(), $scope_id]);
    $db->prepare("UPDATE harvest_jobs SET status = 'done', finished_at = ?, resumption_token = NULL WHERE id = ?")->execute([time(), $job_id]);
}

function fail_harvest_job(PDO $db, int $job_id, int $scope_id, string $error): void
{
    $db->prepare("UPDATE harvest_jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")->execute([time(), $error, $job_id]);
    $db->prepare("UPDATE harvest_scopes SET status = 'failed' WHERE id = ?")->execute([$scope_id]);
}

function prune_harvest_cache(PDO $db): void
{
    $cutoff = time() - HARVEST_MAX_INACTIVE_DAYS * 86400;
    $stmt = $db->prepare('DELETE FROM harvest_scopes WHERE last_accessed_at < ?');
    $stmt->execute([$cutoff]);
    $db->exec("DELETE FROM harvest_jobs WHERE status IN ('done', 'failed') AND finished_at IS NOT NULL AND finished_at < " . (time() - 7 * 86400));
}

function db_bool(mixed $value): bool
{
    if (is_bool($value)) return $value;
    if (is_int($value)) return $value !== 0;
    $text = strtolower((string)$value);
    return in_array($text, ['1', 't', 'true', 'yes'], true);
}
