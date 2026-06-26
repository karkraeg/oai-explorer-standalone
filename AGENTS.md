# AGENTS.md

Leitfaden fuer Coding-Agents in diesem Repository.

## Ziel des Projekts

OAI-PMH-Endpoints interaktiv untersuchen: Repository-Infos lesen, Identifier filtern, Records anzeigen, XML inspizieren.

## Tech-Stack

- Frontend: React UMD + Babel Standalone (ohne Build-Pipeline)
- Backend: `api.php` (OAI-PMH Fetch + XML Parsing + JSON Output)
- Cache: Postgres im Docker-Stack; SQLite (`cache.sqlite`) nur Fallback ohne `DATABASE_URL`
- Background: `worker.php` fuer optionale Identifier-Harvest-Jobs

## Wichtigste Dateien

- `index.html`: Laden von React/ReactDOM/Babel und App-Skripten
- `app.jsx`: Alle Screens, State-Flow und API-Aufrufe
- `styles.css`: komplettes Styling
- `api.php`: Validierung, OAI-Requests, XML-Parsing, Summary-/Response-Cache
- `lib.php`: DB-Migrationen, OAI-Parsing, Cache- und Harvest-Helfer
- `worker.php`: optionaler Background-Harvest fuer Identifier

## Lokales Starten

```bash
php -S 127.0.0.1:8000
```

Danach im Browser: `http://127.0.0.1:8000`

Docker/Postgres-Stack:

```bash
docker compose up --build
```

Danach im Browser: `http://127.0.0.1:8080`

## Cache-Modell

- `endpoint_summaries`: dauerhafte Kennzahlen/Bootstrap-Daten pro Endpoint.
- `response_cache`: kurzlebiger Cache fuer kleine OAI-Responses; `CACHE_TTL` steuert Frische.
- `harvest_*`: optionale Identifier-Harvest-Daten; nicht fuer initiales Oeffnen bekannter Endpoints voraussetzen.
- `resumptionToken` nie als dauerhaft gueltig behandeln; Tokens koennen serverseitig schnell ablaufen.

## Arbeitsregeln fuer Agents

1. Keine Build-Tooling-Migration ohne explizite Anforderung (kein Vite/Webpack/TypeScript-Migration by default).
2. Bestehenden Stil respektieren (Dateistruktur, Benennung, CSS-Konventionen).
3. Kleine, zielgerichtete Aenderungen statt grosser Refactors.
4. API-Verhalten in `api.php` nicht stillschweigend aendern (insbesondere Fehlerformat und Response-Felder).
5. Bei UI-Aenderungen auf Desktop und Mobile achten.
6. Keine sensiblen Daten oder geheimen Keys in Code/Docs eintragen.
7. Dauerhaften Summary-Cache nicht mit grossen Identifier-Seiten oder XML-Records fuellen.

## Checkliste vor Abschluss

1. App startet lokal ueber PHP-Server.
2. Startscreen verbindet sich mit mindestens einem Beispiel-Endpoint.
3. Explore-Ansicht kann Identifier laden.
4. Record-Ansicht zeigt XML oder sinnvolle Fehlermeldung.
5. Keine unnoetigen Aenderungen ausserhalb der Aufgabe.

## Nicht tun (ohne explizite Freigabe)

- Dateien loeschen oder grob umstrukturieren
- API-Response-Schema brechen
- Neue Runtime-Abhaengigkeiten einfuehren
