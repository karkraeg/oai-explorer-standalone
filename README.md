# OAI-PMH Explorer

Ein leichter OAI-PMH-Client im Browser. Die App verbindet sich mit einem OAI-PMH-Endpoint, liest Repository-Metadaten, lädt Identifier-Listen mit Filtern und zeigt einzelne Records inklusive Raw-XML an.

## Was ist das?

Dieses Repository enthaelt eine kleine Web-App mit:

- Frontend in `index.html`, `app.jsx`, `styles.css`
- PHP-Backend in `api.php` als Proxy/Parser für OAI-PMH
- SQLite-Cache in `cache.sqlite` (wird automatisch genutzt)

Die App nutzt im Browser React + Babel Standalone (kein Build-Step mit Vite/Webpack).

## Wie funktioniert es?

1. UI nimmt eine OAI-PMH-Base-URL entgegen.
2. Frontend ruft `api.php` mit `action`-Parametern auf.
3. `api.php` spricht den entfernten OAI-PMH-Endpoint an (`Identify`, `ListMetadataFormats`, `ListSets`, `ListIdentifiers`, `GetRecord`).
4. XML wird serverseitig geparst und als JSON an das Frontend geliefert.
5. Antworten werden per URL-Hash im SQLite-Cache zwischengespeichert.

## Voraussetzungen

- PHP 8.x empfohlen
- PHP-Extensions: `dom`, `pdo_sqlite` (optional `curl`, sonst Fallback via `file_get_contents`)
- Internetzugang zu den OAI-PMH-Endpoints

## Development Server starten

Im Projekt-Root ausfuehren:

```bash
php -S 127.0.0.1:8000
```

Dann im Browser oeffnen:

```text
http://127.0.0.1:8000
```

Hinweis: Ein reiner statischer Server reicht nicht, da `api.php` serverseitig ausgefuehrt werden muss.

## .env Konfiguration (Timeouts etc.)

`api.php` liest optional eine `.env` im Projekt-Root.

Beispiel:

```env
APP_ENV=development
FETCH_TIMEOUT=60
CACHE_TTL=7200
```

Bedeutung:

- `APP_ENV`: `development` oder `production`
- `FETCH_TIMEOUT`: Timeout fuer OAI-HTTP-Requests in Sekunden
- `CACHE_TTL`: Cache-Lebensdauer in Sekunden

## Projektstruktur

```text
.
|- api.php
|- app.jsx
|- index.html
|- styles.css
|- cache.sqlite
```

## API-Aufrufe des Frontends

Alle Requests gehen gegen:

```text
api.php?action=<action>&url=<base-url>
```

Unterstuetzte `action`-Werte:

- `identify`
- `listMetadataFormats`
- `listSets`
- `listIdentifiers`
- `getRecord`

Weitere Query-Parameter je nach Action:

- `prefix`
- `set`
- `from`
- `until`
- `resumptionToken`
- `identifier`

Cache umgehen (nur Entwicklung):

```text
http://127.0.0.1:8000/?nocache=1
```

Wichtig: Der `nocache`-Parameter ist nur aktiv, wenn `APP_ENV != production`.

## Bekannte Hinweise

- Bei nicht erreichbaren Hosts liefert die API `kind: "unreachable"`.
- Bei nicht-OAI/XML-Antworten liefert die API `kind: "not-oai"`.
- `ListSets` kann serverseitig abgeschnitten sein; das wird als `truncated` zurueckgegeben.

## Deployment (einfach)

Die App laeuft auf jedem Webserver mit PHP-Unterstuetzung. Wichtig:

- Dokumentenroot auf dieses Verzeichnis
- Schreibrechte fuer `cache.sqlite` (falls Cache verwendet werden soll)

## Lizenz

Aktuell keine Lizenzdatei hinterlegt.
