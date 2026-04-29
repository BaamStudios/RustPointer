# Presenter-Cursor (RustPointer)

Eigenständige Electron-App, die einen visuellen Laserpointer-Cursor (rot, mit Glow + Trail)
auf dem Bildschirm des Empfängers rendert. Gedacht als Ergänzung zu RustDesk, das selbst
keinen Presenter-Cursor wie TeamViewer bietet.

- **Sender** beobachtet das RustDesk-Fenster per globalem Mouse Hook.
  Linke Maustaste gedrückt + bewegen → Laser auf der Empfängerseite. Klicks werden **nicht
  blockiert** und gehen normal an RustDesk weiter.
- **Receiver** zeigt ein transparentes Vollbild-Overlay (`alwaysOnTop`, click-through) und
  rendert den Laserpointer + Trail auf einem Canvas.
- **Transport**: WebRTC DataChannel (P2P). Ein kleiner WebSocket-Signal-Server koordiniert
  nur das Handshake (SDP Offer/Answer + ICE).

## Verzeichnisstruktur

```
RustPointer/
├── signal-server/      WebSocket Signaling (Node.js, Docker)
│   ├── server.js
│   ├── package.json
│   ├── Dockerfile
│   └── docker-compose.yml
└── app/                Electron-App (Sender + Receiver in einem)
    ├── main.js         Main Process, Tray, Overlay-Window
    ├── preload.js      contextBridge IPC
    ├── window-finder.js  RustDesk-Fenster suchen (node-window-manager)
    ├── mouse-hook.js   Globaler Maus-Hook (uiohook-napi, passiv/read-only)
    ├── overlay.html / overlay.js   Transparentes Canvas-Overlay (Receiver)
    └── control.html / control.js   Settings-UI + WebRTC-Verbindungslogik
```

## Schnellstart

### 1. Signal-Server

Lokal:

```bash
cd signal-server
npm install
node server.js          # lauscht auf Port 3000
```

Docker:

```bash
cd signal-server
docker compose up -d
```

Health-Check: `http://<host>:3000/health`

### 2. App (Sender und Receiver)

Auf beiden Rechnern:

```bash
cd app
npm install
npm start
```

Im UI:

1. **Signal-Server URL** eintragen (z.B. `ws://meinserver:3000`)
2. **Room-ID** auf beiden Seiten gleich setzen (z.B. `test123`)
3. **Verbinden** klicken
4. **Modus** wählen:
   - *Sender* (zeigt Laser auf der Gegenseite),
   - *Receiver* (empfängt Laser),
   - *Bidirektional* (beide Richtungen)
5. Sender: **Presenter-Modus** per Tray-Icon-Klick oder Button aktivieren
6. RustDesk öffnen → linke Maustaste im RustDesk-Fenster halten und bewegen
   → Laserpointer erscheint beim Receiver

### Fenstererkennung

Standardmäßig wird das Fenster gesucht, dessen Titel `RustDesk` enthält. Im Control-UI
lässt sich:
- der **Suchstring** ändern (z.B. `Remote Desktop`)
- oder ein Fenster aus dem Dropdown **manuell auswählen**

## Tray-Icon

| Farbe | Bedeutung                  |
|-------|----------------------------|
| Grau  | Nicht verbunden            |
| Grün  | Verbunden                  |
| Rot   | Presenter-Modus aktiv      |

Linksklick auf das Tray-Icon togglet den Presenter-Modus (sofern Sender/Bidirektional
aktiv ist). Rechtsklick öffnet das Kontextmenü.

## Datenpaket-Format

```json
{ "x": 0.45, "y": 0.62, "pressed": true, "t": 1700000000000 }
```

Koordinaten sind relativ zum RustDesk-Fenster-Bounds (0.0–1.0). Der Receiver skaliert auf
seine Bildschirmgröße.

## Hinweise

- **Kein Block der Klicks**: `uiohook-napi` ist rein passiv. Klicks gehen normal an
  RustDesk und werden remote ausgeführt.
- **Click-through Overlay**: Das Receiver-Overlay nutzt
  `setIgnoreMouseEvents(true, { forward: true })` – der Empfänger merkt das Fenster nicht.
- **STUN**: Standard `stun:stun.l.google.com:19302`. Für strikte NATs zusätzlich einen
  TURN-Server in `RTC_CONFIG` (siehe `app/control.js`) eintragen.
- **Multi-Monitor (Receiver)**: Aktuell wird das Overlay auf dem primären Display
  geöffnet. Für Multi-Monitor-Aufstellung kann die `createOverlayWindow()`-Logik in
  `app/main.js` erweitert werden, ein Overlay pro `screen.getAllDisplays()` zu starten.

## Verifikation

1. Signal-Server starten (`node server.js` oder `docker compose up -d`)
2. Sender-App starten, Room-ID `test123`, **Verbinden**
3. Receiver-App auf zweitem Rechner starten, gleiche Room-ID, **Verbinden**
4. RustDesk auf Sender-Seite öffnen, Remote-Verbindung herstellen
5. Sender: Tray-Icon klicken oder „Presenter EIN/AUS“ → Icon wird **rot**
6. Im RustDesk-Fenster linke Maustaste drücken und bewegen → Laser beim Receiver sichtbar
7. Klicks gehen weiterhin ungehindert an RustDesk (Maus bewegt sich remote)
8. Receiver-Arbeit ist ungestört (Overlay ist click-through)
