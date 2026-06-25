<?php
declare(strict_types=1);

require_once __DIR__ . '/lib.php';
app_bootstrap();
set_time_limit(0);

$once = in_array('--once', $argv, true);
$sleep = env_int('WORKER_SLEEP_SECONDS', 10, 1, 3600);

$db = open_db();

do {
    prune_harvest_cache($db);
    $job = next_harvest_job($db);
    if (!$job) {
        if ($once) break;
        sleep($sleep);
        continue;
    }

    try {
        process_harvest_job($db, $job);
        fwrite(STDOUT, sprintf("Harvest job %d done\n", (int)$job['id']));
    } catch (Throwable $e) {
        fail_harvest_job($db, (int)$job['id'], (int)$job['scope_id'], $e->getMessage());
        fwrite(STDERR, sprintf("Harvest job %d failed: %s\n", (int)$job['id'], $e->getMessage()));
    }
} while (!$once);
