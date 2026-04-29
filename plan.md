# Plan: Presenter-Cursor App (WebRTC + Electron)

## Kontext

RustDesk bietet keinen Presenter-Cursor wie TeamViewer. Ziel ist eine eigenständige Electron-App, die einen visuellen Laserpointer-Cursor auf dem Bildschirm des Empfängers darstellt. Der Sender beobachtet das RustDesk-Fenster per globalem Mouse Hook – Klicks werden **nicht** blockiert und gehen normal weiter. Der Empfänger sieht den Laserpointer über einem transparenten, click-through Overlay und kann ungestört weiterarbeiten.

---

## Dateistruktur

```
presenter-cursor/
├── signal-server/
│   ├── package.json
│   ├── server.js              # WebSocket Signaling Server
│   ├── Dockerfile
│   └── docker-compose.yml
├── app/
│   ├── package.json
│   ├── main.js                # Electron Main Process + Tray
│   ├── preload.js             # IPC Bridge (contextBridge)
│   ├── mouse-hook.js          # Globaler Mouse Hook (Sender)
│   ├── window-finder.js       # RustDesk-Fenster suchen + Bounds ermitteln
│   ├── overlay.html           # Transparentes Vollbild-Canvas (Receiver)
│   ├── overlay.js             # Canvas-Zeichenlogik (Receiver)
│   ├── control.html           # Settings UI
│   └── control.js             # WebRTC-Verbindungslogik
└── README.md
```

---

## Komponenten-Übersicht

### 1. Signal-Server (`signal-server/server.js`)
- Node.js WebSocket-Server, minimal, stateless
- Koordiniert WebRTC Handshake: SDP Offer/Answer + ICE Candidates
- Verwaltet Room-IDs (jeweils 2 Peers pro Room)

#### Docker-Deployment
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm ci --omit=dev
COPY server.js .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

```yaml
# docker-compose.yml
services:
  signal-server:
    build: .
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
    restart: unless-stopped
```

```
Client A ──── WS ──→  Signal-Server  ←── WS ──── Client B
                 SDP Offer / Answer + ICE Candidates
                 → dann direkte P2P Verbindung (WebRTC)
```

---

### 2. Sender-Seite (kein Overlay-Fenster)

**Kein transparentes Fenster auf der Sender-Seite.**  
Stattdessen: globaler Mouse Hook + Win32 Window-Detection.

#### `window-finder.js` – RustDesk-Fenster finden
- Nutzt `node-window-manager` um alle offenen Fenster aufzulisten
- Sucht automatisch nach Fenster mit Titel `"RustDesk"` (konfigurierbar)
- Liefert: `{ x, y, width, height }` des Fensters
- Wird zyklisch (~100ms) aktualisiert, falls Fenster verschoben wird
- Fallback: User kann Fenster manuell aus Dropdown im Control-UI wählen

```js
// Beispiel
const { windowManager } = require('node-window-manager');
const win = windowManager.getWindows()
  .find(w => w.getTitle().includes('RustDesk'));
const bounds = win.getBounds(); // { x, y, width, height }
```

#### `mouse-hook.js` – Globaler Mouse Hook
- Nutzt `uiohook-napi` für systemweite Maus-Events (keine Admin-Rechte nötig)
- Klicks werden **nicht** blockiert – `uiohook-napi` ist rein passiv/read-only
- Logik:
  1. Prüft ob Mausposition innerhalb des RustDesk-Fenster-Bounds liegt
  2. Wenn **linke Taste gedrückt** UND **Presenter-Modus aktiv**: relative Position berechnen und senden
  3. Wenn Taste losgelassen: `pressed: false` senden → Laserpointer beim Receiver ausblenden

```js
uIOhook.on('mousemove', (e) => {
  if (!presenterActive) return;
  const bounds = getCurrentRustDeskBounds();
  if (!isInsideBounds(e.x, e.y, bounds)) return;
  if (!mousePressed) return;
  const rel = { x: (e.x - bounds.x) / bounds.width,
                y: (e.y - bounds.y) / bounds.height,
                pressed: true };
  dataChannel.send(JSON.stringify(rel));
});
```

---

### 3. Receiver-Seite – Overlay-Fenster (`overlay.html`)
- `transparent: true`, `alwaysOnTop: true`, `fullscreen: true`, `frame: false`
- `setIgnoreMouseEvents(true, { forward: true })` → vollständig click-through
- Empfänger merkt nicht, dass das Fenster existiert

#### Canvas-Zeichenlogik (`overlay.js`)
- Zeichnet Laserpointer nur wenn `pressed: true`
- Laserpointer: gefüllter Kreis (Radius 20px) in Rot mit Glow-Effekt
- Fade-out: 1.5 Sekunden nach letztem `pressed: true` Paket
- Spur (Trail): letzte N Positionen mit abnehmender Opazität

```
received({ x, y, pressed })
  if pressed → trail.push({x,y}), drawCursor()
  else       → startFadeOut(1500ms)
```

---

### 4. Electron Main Process (`app/main.js`)
- Startet **nur das Overlay-Fenster** (Receiver)
- Startet Mouse Hook + Window-Finder im Main Process (Sender)
- Tray-Icon:
  - Linksklick → Presenter-Modus ein/aus
  - Rechtsklick → Menü (Verbinden, Modus wählen, Beenden)

---

### 5. Control-Fenster (`app/control.html`)
- Signal-Server URL + Room-ID
- Modus: Sender / Receiver / Bidirektional
- RustDesk-Fenster: automatisch erkannt oder manuell wählen (Dropdown)
- Verbindungsstatus

---

## Datenfluss

```
[Sender: Mouse Hook]
  Maus in RustDesk-Fenster + LMB gedrückt + Presenter aktiv
    → rel. Koordinaten berechnen (0.0–1.0)
    → WebRTC DataChannel.send({ x, y, pressed: true/false })

[Receiver: Overlay]
  DataChannel.onmessage({ x, y, pressed })
    → wenn pressed: Laserpointer auf Canvas zeichnen
    → wenn !pressed: Fade-out starten
```

### Datenpaket-Format
```json
{ "x": 0.45, "y": 0.62, "pressed": true }
```

### Koordinaten-System
- Sender: relative Koordinaten bezogen auf RustDesk-Fenster-Bounds (0.0–1.0)
- Receiver: skaliert auf seine volle Bildschirmgröße
- Unterstützt unterschiedliche Auflösungen / Fenstergrößen

---

## WebRTC Verbindungsaufbau

1. Sender + Receiver starten App, tragen gleiche Room-ID ein
2. Beide verbinden sich per WebSocket mit Signal-Server
3. Sender erstellt SDP Offer → Signal-Server → Receiver
4. Receiver erstellt Answer → Signal-Server → Sender
5. ICE Candidates werden ausgetauscht → NAT Traversal
6. Direkte P2P DataChannel Verbindung steht
7. Signal-Server wird danach nicht mehr gebraucht

**STUN:** `stun:stun.l.google.com:19302` (kostenlos, öffentlich)

---

## Tray-Icon States

| Status | Bedeutung                    |
|--------|------------------------------|
| Grau   | Nicht verbunden              |
| Grün   | Verbunden, Empfänger-Modus   |
| Rot    | Presenter-Modus aktiv        |

---

## Bidirektionaler Modus

- Beide Seiten haben Mouse Hook + Overlay
- Jede Seite kann ihren Presenter-Modus unabhängig aktivieren
- Beide können gleichzeitig zeigen

---

## Umsetzungsschritte

1. `signal-server/` – WS-Server + Dockerfile + docker-compose
2. `app/window-finder.js` – RustDesk-Fenster per `node-window-manager` finden
3. `app/mouse-hook.js` – Globaler Hook per `uiohook-napi`, passiv, kein Blocking
4. `app/main.js` – Electron bootstrap, Tray-Icon, Overlay-Fenster starten
5. `app/preload.js` – IPC Bridge (contextBridge)
6. `app/overlay.html/.js` – Canvas Laserpointer-Rendering (Receiver)
7. `app/control.html/.js` – WebRTC-Verbindungslogik + Settings UI

---

## Dependencies

```json
// signal-server
{ "ws": "^8.x" }

// app
{
  "electron": "^33.x",
  "simple-peer": "^9.x",
  "ws": "^8.x",
  "uiohook-napi": "^1.x",
  "node-window-manager": "^2.x"
}
```

---

## Verifikation

1. Signal-Server starten: `node signal-server/server.js`
   oder Docker: `cd signal-server && docker compose up -d`
2. Sender-App starten, Room-ID `test123`, verbinden
3. Receiver-App starten (zweiter Rechner), gleiche Room-ID
4. RustDesk öffnen (Sender-Rechner), Remote-Verbindung herstellen
5. Presenter-Modus beim Sender aktivieren (Tray-Icon → Rot)
6. Im RustDesk-Fenster linke Maustaste drücken und bewegen
   → Laserpointer erscheint beim Receiver
7. Prüfen: Klicks gehen normal an RustDesk weiter (Maus bewegt sich remote)
8. Prüfen: Receiver-Overlay ist click-through (normale Arbeit ungestört)
9. Bidirektionalen Modus testen
