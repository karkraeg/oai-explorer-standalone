<?php
declare(strict_types=1);

require_once __DIR__ . '/../lib.php';
app_bootstrap();

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
migrate_db($db);

for ($i = 0; $i < 8; $i++) {
    assert(consume_endpoint_rate_limit($db, 'https://EXAMPLE.org/oai/' . $i) === 0);
}
assert(consume_endpoint_rate_limit($db, 'https://example.org:443/oai') === 0);
assert(consume_endpoint_rate_limit($db, 'https://example.org/another-path') > 0);
assert(consume_endpoint_rate_limit($db, 'https://other.example.org/oai') === 0);

assert(public_url_target('http://127.0.0.1/oai') === null);
assert(public_url_target('http://169.254.169.254/latest/meta-data') === null);
assert(public_url_target('http://[::1]/oai') === null);
assert(public_url_target('https://user:pass@93.184.216.34/oai') === null);
assert(public_url_target('file:///etc/passwd') === null);
assert(public_url_target('https://93.184.216.34/oai') !== null);
assert(public_url_target('https://[2606:4700:4700::1111]/oai') !== null);

echo "security test passed\n";
