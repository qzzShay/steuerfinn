# SteuerFinn

Private Web-App (PWA) fürs iPhone: Fahrten, Ausgaben und Einnahmen für **Ausbildung** und **Gewerbe** dokumentieren.
Alle Daten bleiben lokal auf dem Gerät (IndexedDB). Es gibt keinen Server und keine Accounts.

## Funktionen
- **Orte** mit Entfernung, Bereich (Ausbildung/Gewerbe), Abrechnungsart und festen Wochentagen
  - *Arbeitsstätte*: Entfernungspauschale (einfache Strecke, 2026: 0,38 €/km ab km 1), max. 1× pro Tag
  - *Auswärts* (z. B. Berufsschule): Reisekosten 0,30 €/km, Hin- und Rückweg
- **Kalender**: Wochenplan mit einem Tipp eintragen, einzelne Tage ändern, Zeiträume setzen (Blockschule, Urlaub, krank)
- **Belege**: Ausgaben/Einnahmen, beruflicher Anteil in %
- **Scanner**: Ecken automatisch erkennen, Perspektive entzerren, Filter Farbe/S-W, mehrseitig als PDF,
  Texterkennung (Tesseract.js, läuft lokal) füllt Betrag, Datum und Händler vor
- **PIN-Sperre**: Daten und Belege AES-256-GCM verschlüsselt (Schlüssel per PBKDF2 aus 6-stelliger PIN),
  automatisches Sperren im Hintergrund, verschlüsseltes Backup
- **Übersicht** je Steuerjahr: Werbungskosten (Anlage N) und EÜR fürs Gewerbe
- **Export**: CSV (Fahrten, Belege), Belegfotos, JSON-Backup inkl. Fotos

## Veröffentlichen mit GitHub Pages
1. Auf github.com ein neues Repository `steuerfinn` anlegen (public, ohne README).
2. Im Projektordner:
   ```bash
   git remote add origin https://github.com/<DEIN-NAME>/steuerfinn.git
   git push -u origin main
   ```
3. Im Repo: **Settings → Pages → Branch: `main` / root → Save**.
4. Nach ca. 1 Minute: `https://<DEIN-NAME>.github.io/steuerfinn/` auf dem iPhone in **Safari** öffnen,
   dann **Teilen → Zum Home-Bildschirm**.

Im Repo liegt nur der Code. Deine Daten landen nie auf GitHub.

## Lokal testen
```bash
python -m http.server 8765
```
Dann http://localhost:8765 öffnen.

## Hinweise
- Regelmäßig **Backup** machen (Mehr → Backup speichern → „In Dateien sichern“ / iCloud Drive).
- Keine Steuerberatung. Die Pauschalen sind in `app.js` (`pendelBetrag`, `REISE_RATE`) hinterlegt.
